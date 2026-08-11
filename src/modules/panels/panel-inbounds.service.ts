import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { BusinessException } from '@/common/exceptions/business.exception';
import { PrismaService } from '@/common/prisma/prisma.service';
import { PanelsService } from './panels.service';
import type { XuiInbound } from './xui-panel.client';

export interface InboundSyncResult {
  discovered: number;
  created: number;
  updated: number;
  unavailable: number;
  excluded: number;
  eligible: number;
}

export interface SyncedInbound {
  id?: bigint;
  inboundId: string;
  isActive: boolean;
  isRemotePresent: boolean;
  isProvisionable: boolean;
  isExcluded: boolean;
  isClientCompatible: boolean;
}

type SyncDb = Prisma.TransactionClient | PrismaService;

export function isEligibleXuiInbound(panelEnabled: boolean, inbound: SyncedInbound): boolean {
  return panelEnabled &&
    inbound.isRemotePresent &&
    inbound.isActive &&
    inbound.isProvisionable &&
    !inbound.isExcluded &&
    inbound.isClientCompatible &&
    Number.isSafeInteger(Number(inbound.inboundId)) &&
    Number(inbound.inboundId) > 0;
}

@Injectable()
export class PanelInboundsService {
  private readonly logger = new Logger(PanelInboundsService.name);
  // ponytail: This coalesces work in one app process; multi-instance deployments need a shared lock.
  private readonly activeSyncs = new Map<bigint, Promise<InboundSyncResult>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly panels: PanelsService,
  ) {}

  async syncPanelInbounds(panelId: string): Promise<InboundSyncResult> {
    if (!/^\d+$/.test(panelId)) throw BusinessException.notFound('Panel not found');
    const id = BigInt(panelId);
    const active = this.activeSyncs.get(id);
    if (active) return active;
    const sync = this.performSync(id).finally(() => this.activeSyncs.delete(id));
    this.activeSyncs.set(id, sync);
    return sync;
  }

  async eligibleInbounds(panelId: bigint, db: SyncDb = this.prisma): Promise<SyncedInbound[]> {
    const store = this.store(db);
    const panel = await store.vpnPanel.findUnique({ where: { id: panelId } });
    if (!panel || panel.status !== 'ACTIVE' || panel.type !== 'XUI') return [];
    const rows = await store.inboundConfig.findMany({ where: { panelId } });
    return rows.filter((inbound) => isEligibleXuiInbound(true, inbound));
  }

  private async performSync(panelId: bigint): Promise<InboundSyncResult> {
    const store = this.store(this.prisma);
    const panel = await store.vpnPanel.findUnique({ where: { id: panelId } });
    if (!panel) throw BusinessException.notFound('Panel not found');
    if (panel.status !== 'ACTIVE' || panel.type !== 'XUI') {
      throw BusinessException.conflict('Panel is not an enabled XUI panel');
    }
    const server = await store.server.findFirst({ where: { panelId }, orderBy: { createdAt: 'asc' } });
    if (!server) throw BusinessException.conflict('Panel has no server for inbound synchronization');

    let remote: XuiInbound[];
    try {
      const connection = await this.panels.getConnection(panelId);
      const client = this.panels.getClient('XUI') as {
        listInbounds?: (panel: Awaited<ReturnType<PanelsService['getConnection']>>) => Promise<XuiInbound[]>;
      };
      if (!client.listInbounds) {
        throw BusinessException.conflict('XUI inbound listing is unavailable');
      }
      remote = await client.listInbounds(connection);
    } catch {
      await store.vpnPanel.update({
        where: { id: panelId },
        data: { syncStatus: 'FAILED', lastSyncError: 'Inbound synchronization failed' },
      });
      this.logger.warn(`Inbound synchronization failed for panel ${panelId}`);
      throw BusinessException.conflict('XUI inbound synchronization failed');
    }

    const result = await this.prisma.withTransaction(async (tx) => {
      const transaction = this.store(tx);
      const existing = await transaction.inboundConfig.findMany({ where: { panelId } });
      const known = new Map(existing.map((inbound) => [inbound.inboundId, inbound]));
      for (const inbound of remote) {
        const current = known.get(String(inbound.id));
        await transaction.inboundConfig.upsert({
          where: { panelId_inboundId: { panelId, inboundId: String(inbound.id) } },
          create: {
            panelId,
            serverId: server.id,
            inboundId: String(inbound.id),
            protocol: this.protocol(inbound.protocol),
            remark: inbound.remark || inbound.tag || null,
            port: inbound.port,
            isActive: inbound.enabled,
            isRemotePresent: true,
            isProvisionable: true,
            isExcluded: false,
            isClientCompatible: inbound.clientCompatible,
            metadata: this.remoteMetadata(undefined, inbound),
          },
          update: {
            protocol: this.protocol(inbound.protocol),
            remark: inbound.remark || inbound.tag || null,
            port: inbound.port,
            isActive: inbound.enabled,
            isRemotePresent: true,
            isClientCompatible: inbound.clientCompatible,
            metadata: this.remoteMetadata(current?.metadata, inbound),
          },
        });
      }
      const unavailable = await transaction.inboundConfig.updateMany({
        where: { panelId, inboundId: { notIn: remote.map((inbound) => String(inbound.id)) }, isRemotePresent: true },
        data: { isRemotePresent: false, isActive: false, isClientCompatible: false },
      });
      await transaction.vpnPanel.update({
        where: { id: panelId },
        data: { syncStatus: 'SYNCED', lastSyncAt: new Date(), lastSyncError: null },
      });
      const excluded = remote.filter((inbound) => known.get(String(inbound.id))?.isExcluded).length;
      const eligible = remote.filter((inbound) => isEligibleXuiInbound(true, {
        inboundId: String(inbound.id),
        isActive: inbound.enabled,
        isRemotePresent: true,
        isProvisionable: known.get(String(inbound.id))?.isProvisionable ?? true,
        isExcluded: known.get(String(inbound.id))?.isExcluded ?? false,
        isClientCompatible: inbound.clientCompatible,
      })).length;
      return {
        discovered: remote.length,
        created: remote.filter((inbound) => !known.has(String(inbound.id))).length,
        updated: remote.filter((inbound) => known.has(String(inbound.id))).length,
        unavailable: unavailable.count,
        excluded,
        eligible,
      };
    });
    return result;
  }

  private protocol(protocol: string): 'VMESS' | 'VLESS' | 'TROJAN' | 'SHADOWSOCKS' | 'WIREGUARD' | 'REALITY' | 'ANY' {
    const normalized = protocol.toUpperCase();
    return ['VMESS', 'VLESS', 'TROJAN', 'SHADOWSOCKS', 'WIREGUARD', 'REALITY'].includes(normalized)
      ? normalized as 'VMESS' | 'VLESS' | 'TROJAN' | 'SHADOWSOCKS' | 'WIREGUARD' | 'REALITY'
      : 'ANY';
  }

  private remoteMetadata(existing: unknown, inbound: XuiInbound): Record<string, unknown> {
    const previous = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {};
    return { ...previous, remote: { tag: inbound.tag, expiryTime: inbound.expiryTime } };
  }

  private store(db: SyncDb) {
    return db as unknown as {
      vpnPanel: {
        findUnique(args: Record<string, unknown>): Promise<{ id: bigint; status: string; type: string } | null>;
        update(args: Record<string, unknown>): Promise<unknown>;
      };
      server: { findFirst(args: Record<string, unknown>): Promise<{ id: bigint } | null> };
      inboundConfig: {
        findMany(args: Record<string, unknown>): Promise<Array<SyncedInbound & { metadata?: unknown }>>;
        upsert(args: Record<string, unknown>): Promise<unknown>;
        updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
      };
    };
  }
}
