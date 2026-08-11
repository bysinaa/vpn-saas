import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PanelsService } from '../panels/panels.service';
import { PanelInboundsService } from '../panels/panel-inbounds.service';
import { buildSubscriptionUrl } from '../panels/panel-client.interface';

type ProvisioningPlan = {
  panelId?: bigint | null;
  inboundConfigId?: bigint | null;
  inboundPolicy?: 'ALL_ACTIVE' | 'SELECTED';
};

export interface XuiProvisioningTarget {
  panelId: bigint;
  inboundIds: number[];
}

export interface ProvisionedXuiClient {
  subscriptionUrl: string;
  clientLinks: string[];
  subscriptionLinks: string[];
}

/**
 * VpnService - facade over the VPN panel integration.
 * Uses PanelsService + XUIPanelClient to manage 3x-UI users.
 */
@Injectable()
export class VpnService {
  private readonly logger = new Logger(VpnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly panels: PanelsService,
    private readonly inbounds: PanelInboundsService,
  ) {}

  /**
   * Create a 3x-UI client for a subscription.
   * Called by SubscriptionsService.provision() after the subscription row is created.
   */
  async createVpnUserForSubscription(subscriptionId: bigint): Promise<ProvisionedXuiClient | null> {
    // Load subscription with user + plan
    const sub = (await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: true, user: true },
    })) as unknown as {
      id: bigint;
      userId: bigint;
      trafficLimitBytes: bigint | null;
      expiresAt: Date | null;
      deviceLimit: number;
      provisioningPanelId?: bigint | null;
      provisioningInboundIds?: unknown;
      plan: ProvisioningPlan;
      user: { telegramId?: string | null; username?: string | null; firstName?: string | null };
    } | null;
    if (!sub) {
      this.logger.warn(`Subscription ${subscriptionId} not found — skipping VPN creation`);
      return null;
    }

    return this.provisionFirstClassClient(sub);
  }

  private async provisionFirstClassClient(sub: {
    id: bigint;
    userId: bigint;
    trafficLimitBytes: bigint | null;
    expiresAt: Date | null;
    deviceLimit: number;
    provisioningPanelId?: bigint | null;
    provisioningInboundIds?: unknown;
    plan: ProvisioningPlan;
    user: { telegramId?: string | null; username?: string | null };
  }): Promise<ProvisionedXuiClient> {
    const target = this.snapshotTarget(sub) ?? (await this.selectProvisioningTarget(sub.plan));
    await this.updateSubscriptionProvisioning(sub.id, target);
    const panelRow = await this.prisma.vpnPanel.findFirst({
      where: { id: target.panelId, status: 'ACTIVE', type: 'XUI' as never },
    });
    if (!panelRow) throw BusinessException.conflict('Configured XUI panel is not active');

    const connection = await this.panels.getConnection(panelRow.id);
    const client = this.panels.getClient(panelRow.type);
    const metadata = {
      telegramId: sub.user.telegramId ?? null,
      telegramUsername: sub.user.username ?? null,
      inboundIds: target.inboundIds,
    };
    const mapping = await this.claimVpnUserMapping({
      subscriptionId: sub.id,
      userId: sub.userId,
      panelId: panelRow.id,
      proposedUsername: this.generateClientEmail(sub.user, sub.userId),
      trafficLimitBytes: sub.trafficLimitBytes,
      expiryAt: sub.expiresAt,
      metadata,
    });
    const username = mapping.panelUserId;
    const subId = mapping.subToken;
    await this.recordVpnUserMapping({
      subscriptionId: sub.id,
      userId: sub.userId,
      panelId: panelRow.id,
      panelUserId: username,
      subToken: subId,
      trafficLimitBytes: sub.trafficLimitBytes,
      expiryAt: sub.expiresAt,
      syncError: 'Provisioning pending; retry is safe',
      metadata,
    });

    const createInput = {
      username,
      dataLimitBytes: sub.trafficLimitBytes,
      expireMs: sub.expiresAt?.getTime() ?? null,
      deviceLimit: sub.deviceLimit,
      inboundIds: target.inboundIds,
      subId,
      telegramId: sub.user.telegramId ?? undefined,
    };

    try {
      let panelUser = await client.getUser(connection, username);
      if (panelUser) {
        panelUser = await client.updateUser(connection, username, {
          status: 'active',
          dataLimitBytes: sub.trafficLimitBytes,
          expireMs: sub.expiresAt?.getTime() ?? null,
          deviceLimit: sub.deviceLimit,
          subId,
          telegramId: sub.user.telegramId ?? undefined,
        });
        const attachClient = (
          client as typeof client & {
            attachClient?: (
              panel: typeof connection,
              email: string,
              inboundIds: number[],
            ) => Promise<void>;
          }
        ).attachClient;
        if (attachClient) await attachClient.call(client, connection, username, target.inboundIds);
      } else {
        try {
          panelUser = await client.createUser(connection, createInput);
        } catch (error: unknown) {
          panelUser = await client.getUser(connection, username);
          if (!panelUser && this.isAmbiguousCreateError(error)) {
            panelUser = await client.createUser(connection, createInput);
          }
          if (!panelUser) throw error;
        }
      }
      if (!panelUser) throw BusinessException.conflict('XUI did not create the requested client');

      const subscriptionUrl = buildSubscriptionUrl(connection, subId);
      const deliveryClient = client as typeof client & {
        clientLinks?: (panel: typeof connection, email: string) => Promise<string[]>;
        subscriptionLinks?: (panel: typeof connection, id: string) => Promise<string[]>;
      };
      const [clientLinks, subscriptionLinks] = await Promise.all([
        deliveryClient.clientLinks?.(connection, username) ?? Promise.resolve([]),
        deliveryClient.subscriptionLinks?.(connection, subId) ?? Promise.resolve([]),
      ]);
      await this.updateSubscriptionDelivery(sub.id, subscriptionUrl);
      await this.recordVpnUserMapping({
        subscriptionId: sub.id,
        userId: sub.userId,
        panelId: panelRow.id,
        panelUserId: username,
        subLink: subscriptionUrl,
        subToken: subId,
        trafficLimitBytes: sub.trafficLimitBytes,
        expiryAt: sub.expiresAt,
        metadata,
      });
      this.logger.log(`XUI client provisioned for subscription ${sub.id}`);
      return { subscriptionUrl, clientLinks, subscriptionLinks };
    } catch {
      await this.recordVpnUserMapping({
        subscriptionId: sub.id,
        userId: sub.userId,
        panelId: panelRow.id,
        panelUserId: username,
        subToken: subId,
        trafficLimitBytes: sub.trafficLimitBytes,
        expiryAt: sub.expiresAt,
        syncError: 'XUI provisioning failed; retry is safe',
        metadata,
      });
      this.logger.warn(`XUI provisioning pending for subscription ${sub.id}`);
      throw BusinessException.conflict('VPN provisioning is pending and can be retried');
    }
  }

  /** Database-only target selection used before canonical order completion. */
  async selectProvisioningTarget(
    plan: ProvisioningPlan,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<XuiProvisioningTarget> {
    const store = db as unknown as {
      vpnPanel: { findFirst(args: Record<string, unknown>): Promise<{ id: bigint } | null> };
    };
    const panel = await store.vpnPanel.findFirst({
      where: plan.panelId
        ? { id: plan.panelId, status: 'ACTIVE', type: 'XUI' as never }
        : { status: 'ACTIVE', type: 'XUI' as never },
      orderBy: { createdAt: 'asc' },
    });
    if (!panel) throw BusinessException.conflict('No enabled XUI panel is available for this plan');
    const eligible = await this.inbounds.eligibleInbounds(panel.id, db);
    const inboundIds = [
      ...new Set(
        eligible
          .filter(
            (inbound) => plan.inboundPolicy !== 'SELECTED' || inbound.id === plan.inboundConfigId,
          )
          .map((inbound) => Number(inbound.inboundId)),
      ),
    ].sort((a, b) => a - b);
    if (!inboundIds.length)
      throw BusinessException.conflict('No eligible active XUI inbound is available for this plan');
    return { panelId: panel.id, inboundIds };
  }

  /** Explicit admin action; existing subscriptions never auto-attach new inbounds. */
  async reconcileSubscriptionInbounds(subscriptionId: bigint): Promise<void> {
    const sub = (await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: true, vpnUser: true },
    })) as unknown as { plan: ProvisioningPlan; vpnUser: { panelUserId: string } | null } | null;
    if (!sub?.vpnUser) throw BusinessException.notFound('VPN user not provisioned yet');
    const target = await this.selectProvisioningTarget(sub.plan);
    const connection = await this.panels.getConnection(target.panelId);
    const client = this.panels.getClient(connection.type ?? 'XUI') as {
      attachClient?: (
        panel: typeof connection,
        email: string,
        inboundIds: number[],
      ) => Promise<void>;
    };
    if (!client.attachClient)
      throw BusinessException.conflict('Selected panel does not support inbound reconciliation');
    await client.attachClient(connection, sub.vpnUser.panelUserId, target.inboundIds);
    await this.updateSubscriptionProvisioning(subscriptionId, target);
  }

  private generateClientEmail(
    user: { telegramId?: string | null; username?: string | null },
    userId: bigint,
  ): string {
    const telegramId = user.telegramId?.trim() || userId.toString();
    const username = user.username
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return username ? `tg_${username}_${telegramId}` : `tg_${telegramId}`;
  }

  private snapshotTarget(sub: {
    provisioningPanelId?: bigint | null;
    provisioningInboundIds?: unknown;
  }): XuiProvisioningTarget | null {
    if (!sub.provisioningPanelId || !Array.isArray(sub.provisioningInboundIds)) return null;
    const inboundIds = [
      ...new Set(
        sub.provisioningInboundIds.filter(
          (id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
        ),
      ),
    ].sort((a, b) => a - b);
    return inboundIds.length ? { panelId: sub.provisioningPanelId, inboundIds } : null;
  }

  private isAmbiguousCreateError(error: unknown): boolean {
    return /timeout|abort|request error/i.test(
      error instanceof Error ? error.message : String(error),
    );
  }

  private async claimVpnUserMapping(params: {
    subscriptionId: bigint;
    userId: bigint;
    panelId: bigint;
    proposedUsername: string;
    trafficLimitBytes: bigint | null;
    expiryAt: Date | null;
    metadata: Record<string, unknown>;
  }): Promise<{ panelUserId: string; subToken: string }> {
    const proposedSubId = crypto.randomUUID();
    const collision = await this.prisma.vpnUser.findUnique({
      where: { panelUserId: params.proposedUsername },
      select: { subscriptionId: true },
    });
    const suffixedUsername = `${params.proposedUsername}_s${params.subscriptionId}`;
    let panelUserId =
      collision && collision.subscriptionId !== params.subscriptionId
        ? suffixedUsername
        : params.proposedUsername;
    const claim = (username: string) =>
      this.prisma.vpnUser.upsert({
        where: { subscriptionId: params.subscriptionId },
        update: {},
        create: {
          panelId: params.panelId,
          panelUserId: username,
          userId: params.userId,
          subscriptionId: params.subscriptionId,
          subToken: proposedSubId,
          totalTrafficBytes: params.trafficLimitBytes,
          expiryAt: params.expiryAt,
          metadata: params.metadata as any,
          status: 'DISABLED' as const,
          syncError: 'Provisioning pending; retry is safe',
        },
      });
    let mapping;
    try {
      mapping = await claim(panelUserId);
    } catch (error: any) {
      if (error?.code !== 'P2002' || panelUserId === suffixedUsername) throw error;
      panelUserId = suffixedUsername;
      mapping = await claim(panelUserId);
    }

    if (!mapping.subToken) {
      await this.prisma.vpnUser.updateMany({
        where: { id: mapping.id, subToken: null },
        data: { subToken: proposedSubId },
      });
    }
    if (!mapping.panelUserId) {
      await this.prisma.vpnUser.updateMany({
        where: { id: mapping.id, panelUserId: '' },
        data: { panelUserId: params.proposedUsername },
      });
    }
    if (!mapping.subToken || !mapping.panelUserId) {
      mapping = await this.prisma.vpnUser.findUniqueOrThrow({
        where: { id: mapping.id },
      });
    }
    return { panelUserId: mapping.panelUserId, subToken: mapping.subToken! };
  }

  private async updateSubscriptionProvisioning(
    subscriptionId: bigint,
    target: XuiProvisioningTarget,
  ): Promise<void> {
    const subscriptions = this.prisma.subscription as unknown as {
      update(args: {
        where: { id: bigint };
        data: { provisioningPanelId: bigint; provisioningInboundIds: number[] };
      }): Promise<unknown>;
    };
    await subscriptions.update({
      where: { id: subscriptionId },
      data: { provisioningPanelId: target.panelId, provisioningInboundIds: target.inboundIds },
    });
  }

  private async updateSubscriptionDelivery(
    subscriptionId: bigint,
    subscriptionLink: string,
  ): Promise<void> {
    const subscriptions = this.prisma.subscription as unknown as {
      update(args: { where: { id: bigint }; data: { subscriptionLink: string } }): Promise<unknown>;
    };
    await subscriptions.update({ where: { id: subscriptionId }, data: { subscriptionLink } });
  }

  /** Fetch real-time usage from 3x-UI panel for a subscription. */
  async getUsageFromPanel(subscriptionId: bigint): Promise<{
    usedBytes: bigint;
    totalBytes: bigint | null;
    expiresAt: Date | null;
    status: string;
    subLink: string | null;
  } | null> {
    try {
      const vpnUser = await this.prisma.vpnUser.findUnique({
        where: { subscriptionId },
        include: { panel: true },
      });
      if (!vpnUser || !vpnUser.panel) return null;

      const connection = await this.panels.getConnection(vpnUser.panelId);
      const client = this.panels.getClient(vpnUser.panel.type);

      // Use the dedicated traffic endpoint for accurate real-time data
      const traffic = await client.getClientTraffic(connection, vpnUser.panelUserId);

      if (!traffic) {
        // Fall back to getUser() if traffic endpoint fails
        const panelUser = await client.getUser(connection, vpnUser.panelUserId);
        if (!panelUser) return null;

        const usedBytes = BigInt(panelUser.usedBytes ?? '0');
        const totalBytes = panelUser.dataLimitBytes ? BigInt(panelUser.dataLimitBytes) : null;
        const expiryMs = panelUser.expiryMs;
        const status = panelUser.status.toUpperCase();
        const subLink = panelUser.subLink ?? null;

        await this.prisma.vpnUser.update({
          where: { id: vpnUser.id },
          data: {
            usedTrafficBytes: usedBytes,
            lastSyncAt: new Date(),
          },
        });

        await this.prisma.subscription.update({
          where: { id: subscriptionId },
          data: { usedTrafficBytes: usedBytes },
        });

        return {
          usedBytes,
          totalBytes,
          expiresAt: expiryMs ? new Date(expiryMs) : null,
          status,
          subLink,
        };
      }

      // Parse traffic data from the dedicated endpoint
      const usedBytes = BigInt(traffic.usedBytes);
      const totalBytes = traffic.totalBytes ? BigInt(traffic.totalBytes) : null;
      const expiryMs = traffic.expiryTime > 0 ? traffic.expiryTime : null;
      const status = traffic.enable ? 'ACTIVE' : 'DISABLED';
      const subLink = traffic.subId ? buildSubscriptionUrl(connection, traffic.subId) : null;

      // Update local DB with fresh data from the traffic endpoint
      await this.prisma.vpnUser.update({
        where: { id: vpnUser.id },
        data: {
          usedTrafficBytes: usedBytes,
          lastSyncAt: new Date(),
        },
      });

      await this.prisma.subscription.update({
        where: { id: subscriptionId },
        data: { usedTrafficBytes: usedBytes },
      });

      return {
        usedBytes,
        totalBytes,
        expiresAt: expiryMs ? new Date(expiryMs) : null,
        status,
        subLink,
      };
    } catch {
      this.logger.warn(`Panel usage sync failed for subscription ${subscriptionId}`);
      return null;
    }
  }

  async suspendVpnUser(subscriptionId: bigint): Promise<void> {
    await this.setRemoteStatus(subscriptionId, false);
  }

  async resumeVpnUser(subscriptionId: bigint): Promise<void> {
    await this.setRemoteStatus(subscriptionId, true);
  }

  async resetTraffic(subscriptionId: bigint): Promise<void> {
    const target = await this.runtimeTargetForSubscription(subscriptionId);
    try {
      await target.client.resetTraffic(target.connection, target.vpnUser.panelUserId);
      await this.prisma.withTransaction(async (tx) => {
        await tx.vpnUser.update({
          where: { id: target.vpnUser.id },
          data: { usedTrafficBytes: 0n, lastSyncAt: new Date(), syncError: null },
        });
        await tx.subscription.update({
          where: { id: subscriptionId },
          data: { usedTrafficBytes: 0n },
        });
        await tx.subscriptionEvent.create({
          data: { subscriptionId, event: 'RESET' },
        });
      });
      this.logger.log(`XUI traffic reset for subscription ${subscriptionId}`);
    } catch {
      await this.failRuntimeOperation(target.vpnUser.id, subscriptionId, 'traffic reset');
    }
  }

  /** Delete panel user (when subscription cancelled). */
  async deleteVpnUser(vpnUserId: bigint): Promise<void> {
    const vpnUser = await this.prisma.vpnUser.findUnique({ where: { id: vpnUserId } });
    if (!vpnUser) return;
    const connection = await this.panels.getConnection(vpnUser.panelId);
    const client = this.panels.getClient(connection.type ?? 'XUI');
    try {
      const remoteUser = await client.getUser(connection, vpnUser.panelUserId);
      if (remoteUser) {
        try {
          await client.deleteUser(connection, vpnUser.panelUserId);
        } catch (error) {
          if (await client.getUser(connection, vpnUser.panelUserId)) throw error;
        }
      }
      await this.prisma.withTransaction(async (tx) => {
        if (vpnUser.subscriptionId) {
          await tx.subscription.update({
            where: { id: vpnUser.subscriptionId },
            data: { status: 'CANCELLED', pausedAt: null, subscriptionLink: null },
          });
          await tx.subscriptionEvent.create({
            data: { subscriptionId: vpnUser.subscriptionId, event: 'CANCELLED' },
          });
        }
        await tx.vpnUser.delete({ where: { id: vpnUser.id } });
      });
      this.logger.log(`XUI client deleted for VPN user ${vpnUserId}`);
    } catch {
      await this.failRuntimeOperation(vpnUser.id, vpnUser.subscriptionId, 'client deletion');
    }
  }

  private async setRemoteStatus(subscriptionId: bigint, enabled: boolean): Promise<void> {
    const target = await this.runtimeTargetForSubscription(subscriptionId);
    const operation = enabled ? 'resume' : 'suspend';
    try {
      await target.client.updateUser(target.connection, target.vpnUser.panelUserId, {
        status: enabled ? 'active' : 'disabled',
      });
      await this.prisma.withTransaction(async (tx) => {
        await tx.vpnUser.update({
          where: { id: target.vpnUser.id },
          data: {
            status: enabled ? 'ACTIVE' : 'DISABLED',
            lastSyncAt: new Date(),
            syncError: null,
          },
        });
        await tx.subscription.update({
          where: { id: subscriptionId },
          data: { status: enabled ? 'ACTIVE' : 'SUSPENDED', pausedAt: null },
        });
        await tx.subscriptionEvent.create({
          data: { subscriptionId, event: enabled ? 'RESUMED' : 'SUSPENDED' },
        });
      });
      this.logger.log(`XUI client ${operation} succeeded for subscription ${subscriptionId}`);
    } catch {
      await this.failRuntimeOperation(target.vpnUser.id, subscriptionId, operation);
    }
  }

  private async runtimeTargetForSubscription(subscriptionId: bigint) {
    const vpnUser = await this.prisma.vpnUser.findUnique({ where: { subscriptionId } });
    if (!vpnUser) throw BusinessException.notFound('VPN user not provisioned yet');
    const connection = await this.panels.getConnection(vpnUser.panelId);
    return {
      vpnUser,
      connection,
      client: this.panels.getClient(connection.type ?? 'XUI'),
    };
  }

  private async failRuntimeOperation(
    vpnUserId: bigint,
    subscriptionId: bigint | null,
    operation: string,
  ): Promise<never> {
    await this.prisma.vpnUser
      .update({
        where: { id: vpnUserId },
        data: { syncError: `XUI ${operation} failed; retry is safe` },
      })
      .catch(() => undefined);
    this.logger.warn(
      `XUI ${operation} pending${subscriptionId ? ` for subscription ${subscriptionId}` : ''}`,
    );
    throw BusinessException.conflict(`VPN ${operation} failed and can be retried`);
  }

  /**
   * Sync usage from the panel back into our DB (called by the sync worker).
   * Returns updated used traffic bytes.
   */
  async syncUsage(vpnUserId: bigint, usedBytes: bigint): Promise<void> {
    const vpnUser = await this.prisma.vpnUser.findUnique({
      where: { id: vpnUserId },
      include: { subscription: true },
    });
    if (!vpnUser || !vpnUser.subscription) return;

    await this.prisma.vpnUser.update({
      where: { id: vpnUserId },
      data: { usedTrafficBytes: usedBytes, lastSyncAt: new Date() },
    });

    await this.prisma.subscription.update({
      where: { id: vpnUser.subscriptionId! },
      data: { usedTrafficBytes: usedBytes },
    });

    // Low-traffic alert (logging only for now)
    if (vpnUser.subscription.trafficLimitBytes) {
      const pct = Number((usedBytes * 100n) / vpnUser.subscription.trafficLimitBytes);
      if (pct >= 80 && pct < 85) {
        this.logger.warn(`Low traffic alert: subscription ${vpnUser.subscriptionId} at ${pct}%`);
      }
    }
  }

  /** Persist the mapping between a subscription and the panel user. */
  async recordVpnUserMapping(params: {
    subscriptionId: bigint;
    userId: bigint;
    panelId: bigint;
    panelUserId?: string;
    subLink?: string;
    subToken?: string;
    trafficLimitBytes?: bigint | null;
    expiryAt?: Date | null;
    syncError?: string;
    metadata?: Record<string, unknown>;
    tx?: PrismaClient;
  }): Promise<void> {
    const db = params.tx ?? this.prisma;
    const updateData: Record<string, unknown> = {
      panelId: params.panelId,
      panelUserId: params.panelUserId ?? '',
      subLink: params.subLink,
      subToken: params.subToken,
      totalTrafficBytes: params.trafficLimitBytes,
      expiryAt: params.expiryAt,
      metadata: params.metadata,
      lastSyncAt: new Date(),
      status: params.syncError ? 'DISABLED' : 'ACTIVE',
      syncError: params.syncError ?? null,
    };
    await db.vpnUser.upsert({
      where: { subscriptionId: params.subscriptionId },
      update: updateData as any,
      create: {
        panelId: params.panelId,
        panelUserId: params.panelUserId ?? '',
        userId: params.userId,
        subscriptionId: params.subscriptionId,
        subLink: params.subLink,
        subToken: params.subToken,
        totalTrafficBytes: params.trafficLimitBytes,
        expiryAt: params.expiryAt,
        metadata: params.metadata as any,
        lastSyncAt: new Date(),
        status: params.syncError ? 'DISABLED' : 'ACTIVE',
        syncError: params.syncError ?? null,
      },
    });
  }

  async getVpnUserForSubscription(subscriptionId: bigint) {
    const vpnUser = await this.prisma.vpnUser.findUnique({
      where: { subscriptionId },
    });
    if (!vpnUser) throw BusinessException.notFound('VPN user not provisioned yet');
    return vpnUser;
  }
}
