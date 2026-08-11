import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { encrypt } from '@/common/utils/crypto.util';
import { isEligibleXuiInbound, PanelInboundsService } from './panel-inbounds.service';
import type { XuiInbound } from './xui-panel.client';
import { PanelsService } from './panels.service';

export interface XuiInstallerConnection {
  baseUrl: string;
  username: string;
  password: string;
  subPort: number | null;
  subPath: string;
}

export interface XuiDriftObservation {
  baseUrl: string;
  subPort: number | null;
  subPath: string;
  source: string;
  observedAt: string;
  listenerCoherent: boolean;
  hostDetected?: boolean;
}

export interface XuiDiagnosticResult {
  state: 'NOT_CONFIGURED' | 'AUTH_REQUIRED' | 'UNHEALTHY' | 'CONNECTED';
  authentication: 'NOT_ATTEMPTED' | 'AUTH_REQUIRED' | 'AUTHENTICATED' | 'FAILED';
  apiProbe: boolean;
  applicationConnectivity: boolean;
  panel: null | { baseUrl: string; subPort: number | null; subPath: string | null; healthStatus: string; syncStatus: string };
  reconciliation: { vpnPanel: boolean; serverCount: number; inboundConfigCount: number };
  inbounds: { discovered: number; enabled: number; eligible: number };
  drift: { detected: boolean; listenerCoherent: boolean; classification: 'NONE' | 'SAFE_CANDIDATE' | 'UNSAFE_LISTENER' };
}

/** Reconciles the installer-discovered XUI connection into the runtime DB. */
@Injectable()
export class PanelInstallerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inbounds: PanelInboundsService,
    private readonly panels: PanelsService,
  ) {}

  async reconcileXui(input: XuiInstallerConnection) {
    const url = new URL(input.baseUrl);
    const existing = await this.prisma.vpnPanel.findFirst({
      where: { type: 'XUI', baseUrl: input.baseUrl },
      orderBy: { createdAt: 'asc' },
    });
    const panel = existing
      ? await this.prisma.vpnPanel.update({
          where: { id: existing.id },
          data: {
            apiKey: encrypt(`${input.username}:${input.password}`),
            subPort: input.subPort,
            subPath: input.subPath,
            status: 'ACTIVE',
            healthStatus: 'UNKNOWN',
          },
        })
      : await this.prisma.vpnPanel.create({
          data: {
            name: `3X-UI ${url.hostname}`,
            type: 'XUI',
            baseUrl: input.baseUrl,
            apiKey: encrypt(`${input.username}:${input.password}`),
            subPort: input.subPort,
            subPath: input.subPath,
            status: 'ACTIVE',
          },
        });

    const server = await this.prisma.server.findFirst({
      where: { panelId: panel.id },
      orderBy: { createdAt: 'asc' },
    });
    if (server) {
      if (server.hostname !== url.hostname) {
        const owner = await this.prisma.server.findUnique({ where: { hostname: url.hostname } });
        if (owner && owner.id !== server.id) throw new Error('Panel host is already bound to a different server');
      }
      await this.prisma.server.update({
        where: { id: server.id },
        data: { hostname: url.hostname, ip: url.hostname, status: 'ONLINE' },
      });
    } else {
      const owner = await this.prisma.server.findUnique({ where: { hostname: url.hostname } });
      if (owner) throw new Error('Panel host is already bound to a different server');
      await this.prisma.server.create({
        data: {
          panelId: panel.id,
          name: `3X-UI ${url.hostname}`,
          hostname: url.hostname,
          ip: url.hostname,
          status: 'ONLINE',
        },
      });
    }

    try {
      const synchronization = await this.inbounds.syncPanelInbounds(panel.id.toString());
      if (synchronization.eligible < 1) throw new Error('No eligible XUI inbounds are available for provisioning');
      await this.prisma.vpnPanel.update({ where: { id: panel.id }, data: { healthStatus: 'HEALTHY' } });
      return { panelId: panel.id.toString(), synchronization };
    } catch (error) {
      await this.prisma.vpnPanel.update({ where: { id: panel.id }, data: { healthStatus: 'UNHEALTHY' } });
      throw error;
    }
  }

  /**
   * Reconciles a fresh, host-discovered endpoint only after the app container
   * authenticates to it with the already-encrypted runtime credential.
   */
  async reconcileXuiDrift(input: XuiDriftObservation) {
    if (!input.listenerCoherent) throw new Error('Discovered XUI listener is not coherent; endpoint was not changed');
    const panel = await this.prisma.vpnPanel.findFirst({ where: { type: 'XUI' }, orderBy: { createdAt: 'asc' } });
    if (!panel) throw new Error('No XUI panel is registered for drift reconciliation');

    const current = await this.panels.getConnection(panel.id);
    const candidate = { ...current, baseUrl: input.baseUrl, subPort: input.subPort ?? undefined, subPath: input.subPath };
    try {
      const client = this.panels.getClient('XUI') as unknown as { listInbounds(panel: typeof candidate): Promise<unknown[]> };
      await client.listInbounds(candidate);
    } catch (error) {
      const authRequired = error instanceof Error && /login|credential|unauthoriz|401|403/i.test(error.message);
      await this.prisma.vpnPanel.update({
        where: { id: panel.id },
        data: { healthStatus: authRequired ? 'AUTH_REQUIRED' : 'UNHEALTHY' },
      });
      throw error;
    }

    const changed = panel.baseUrl !== input.baseUrl || panel.subPort !== input.subPort || panel.subPath !== input.subPath;
    if (changed) {
      await this.prisma.vpnPanel.update({
        where: { id: panel.id },
        data: {
          baseUrl: input.baseUrl,
          subPort: input.subPort,
          subPath: input.subPath,
          metadata: { ...((panel.metadata as Record<string, unknown>) ?? {}), xuiDrift: { source: input.source, observedAt: input.observedAt } },
        },
      });
    }

    try {
      const synchronization = await this.inbounds.syncPanelInbounds(panel.id.toString());
      if (synchronization.eligible < 1) throw new Error('No eligible XUI inbounds are available for provisioning');
      await this.prisma.vpnPanel.update({ where: { id: panel.id }, data: { healthStatus: 'HEALTHY' } });
      return { panelId: panel.id.toString(), changed, synchronization };
    } catch (error) {
      await this.prisma.vpnPanel.update({ where: { id: panel.id }, data: { healthStatus: 'UNHEALTHY' } });
      throw error;
    }
  }

  /** Read-only runtime diagnosis. It never updates panel, server, or inbound state. */
  async diagnoseXui(input: XuiDriftObservation): Promise<XuiDiagnosticResult> {
    const panel = await this.prisma.vpnPanel.findFirst({ where: { type: 'XUI' }, orderBy: { createdAt: 'asc' } });
    const drift = panel && input.hostDetected !== false
      ? panel.baseUrl !== input.baseUrl || panel.subPort !== input.subPort || panel.subPath !== input.subPath
      : false;
    const driftResult = {
      detected: drift,
      listenerCoherent: input.listenerCoherent,
      classification: (drift ? input.listenerCoherent ? 'SAFE_CANDIDATE' : 'UNSAFE_LISTENER' : 'NONE') as 'NONE' | 'SAFE_CANDIDATE' | 'UNSAFE_LISTENER',
    };
    if (!panel) {
      return {
        state: 'NOT_CONFIGURED', authentication: 'NOT_ATTEMPTED', apiProbe: false, applicationConnectivity: false,
        panel: null, reconciliation: { vpnPanel: false, serverCount: 0, inboundConfigCount: 0 },
        inbounds: { discovered: 0, enabled: 0, eligible: 0 }, drift: driftResult,
      };
    }

    const [serverCount, stored] = await Promise.all([
      this.prisma.server.count({ where: { panelId: panel.id } }),
      this.prisma.inboundConfig.findMany({ where: { panelId: panel.id } }),
    ]);
    const base = {
      panel: { baseUrl: panel.baseUrl, subPort: panel.subPort, subPath: panel.subPath, healthStatus: panel.healthStatus, syncStatus: panel.syncStatus },
      reconciliation: { vpnPanel: true, serverCount, inboundConfigCount: stored.length },
      drift: driftResult,
    };
    try {
      const connection = await this.panels.getConnection(panel.id);
      const candidate = { ...connection, baseUrl: input.baseUrl, subPort: input.subPort ?? undefined, subPath: input.subPath };
      const client = this.panels.getClient('XUI') as unknown as { listInbounds(panel: typeof candidate): Promise<XuiInbound[]> };
      const remote = await client.listInbounds(candidate);
      const known = new Map(stored.map((inbound) => [inbound.inboundId, inbound]));
      const eligible = remote.filter((inbound) => {
        const current = known.get(String(inbound.id));
        return isEligibleXuiInbound(panel.status === 'ACTIVE', {
          inboundId: String(inbound.id), isActive: inbound.enabled, isRemotePresent: true,
          isProvisionable: current?.isProvisionable ?? true, isExcluded: current?.isExcluded ?? false,
          isClientCompatible: inbound.clientCompatible,
        });
      }).length;
      return {
        ...base,
        state: eligible > 0 ? 'CONNECTED' : 'UNHEALTHY',
        authentication: 'AUTHENTICATED', apiProbe: true, applicationConnectivity: true,
        inbounds: { discovered: remote.length, enabled: remote.filter((inbound) => inbound.enabled).length, eligible },
      };
    } catch (error) {
      const authRequired = error instanceof Error && /login|credential|unauthoriz|401|403/i.test(error.message);
      return {
        ...base,
        state: authRequired ? 'AUTH_REQUIRED' : 'UNHEALTHY',
        authentication: authRequired ? 'AUTH_REQUIRED' : 'FAILED', apiProbe: false, applicationConnectivity: false,
        inbounds: { discovered: 0, enabled: 0, eligible: 0 },
      };
    }
  }
}
