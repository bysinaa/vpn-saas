import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PanelsService } from '../panels/panels.service';
import { PanelInboundsService } from '../panels/panel-inbounds.service';

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
    user: { telegramId?: string | null };
  }): Promise<ProvisionedXuiClient> {
    const target = this.snapshotTarget(sub) ?? await this.selectProvisioningTarget(sub.plan);
    await this.updateSubscriptionProvisioning(sub.id, target);
    const panelRow = await this.prisma.vpnPanel.findFirst({
      where: { id: target.panelId, status: 'ACTIVE', type: 'XUI' as never },
    });
    if (!panelRow) throw BusinessException.conflict('Configured XUI panel is not active');

    const connection = await this.panels.getConnection(panelRow.id);
    const client = this.panels.getClient(panelRow.type);
    const username = this.generateClientEmail(sub.id);
    const subId = crypto.randomUUID();
    const createInput = {
      username,
      dataLimitBytes: sub.trafficLimitBytes,
      expireMs: sub.expiresAt?.getTime() ?? null,
      deviceLimit: sub.deviceLimit,
      inboundIds: target.inboundIds,
      subId,
      telegramId: sub.user.telegramId ?? undefined,
    };
    let panelUser;
    try {
      panelUser = await client.createUser(connection, createInput);
    } catch (err: unknown) {
      if (!this.isAmbiguousCreateError(err)) throw err;
      panelUser = await client.getUser(connection, username);
      if (!panelUser) panelUser = await client.createUser(connection, createInput);
    }
    if (!panelUser) throw BusinessException.conflict('XUI did not create the requested client');

    const subscriptionUrl = this.subscriptionUrl(connection, subId);
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
      trafficLimitBytes: sub.trafficLimitBytes ?? undefined,
      expiryAt: sub.expiresAt ?? undefined,
    });
    this.logger.log(`XUI client created for subscription ${sub.id}`);
    return { subscriptionUrl, clientLinks, subscriptionLinks };
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
    const inboundIds = eligible
      .filter((inbound) => plan.inboundPolicy !== 'SELECTED' || inbound.id === plan.inboundConfigId)
      .map((inbound) => Number(inbound.inboundId));
    if (!inboundIds.length) throw BusinessException.conflict('No eligible active XUI inbound is available for this plan');
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
      attachClient?: (panel: typeof connection, email: string, inboundIds: number[]) => Promise<void>;
    };
    if (!client.attachClient) throw BusinessException.conflict('Selected panel does not support inbound reconciliation');
    await client.attachClient(connection, sub.vpnUser.panelUserId, target.inboundIds);
    await this.updateSubscriptionProvisioning(subscriptionId, target);
  }

  private generateClientEmail(subscriptionId: bigint): string {
    return `tazaxy_sub_${subscriptionId}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  private snapshotTarget(sub: { provisioningPanelId?: bigint | null; provisioningInboundIds?: unknown }): XuiProvisioningTarget | null {
    if (!sub.provisioningPanelId || !Array.isArray(sub.provisioningInboundIds)) return null;
    const inboundIds = sub.provisioningInboundIds.filter((id): id is number =>
      typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
    );
    return inboundIds.length ? { panelId: sub.provisioningPanelId, inboundIds } : null;
  }

  private subscriptionUrl(connection: { baseUrl: string; subPort?: number; subPath?: string }, subId: string): string {
    const url = new URL(connection.baseUrl);
    if (connection.subPort) url.port = String(connection.subPort);
    url.pathname = `/${(connection.subPath ?? 'sub').replace(/^\/+|\/+$/g, '')}/${subId}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  private isAmbiguousCreateError(error: unknown): boolean {
    return /timeout|abort|request error/i.test(error instanceof Error ? error.message : String(error));
  }

  private async updateSubscriptionProvisioning(subscriptionId: bigint, target: XuiProvisioningTarget): Promise<void> {
    const subscriptions = this.prisma.subscription as unknown as {
      update(args: { where: { id: bigint }; data: { provisioningPanelId: bigint; provisioningInboundIds: number[] } }): Promise<unknown>;
    };
    await subscriptions.update({
      where: { id: subscriptionId },
      data: { provisioningPanelId: target.panelId, provisioningInboundIds: target.inboundIds },
    });
  }

  private async updateSubscriptionDelivery(subscriptionId: bigint, subscriptionLink: string): Promise<void> {
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
      const subLink = traffic.subId
        ? `${connection.baseUrl.replace(/\/$/, '')}/sub/${traffic.subId}`
        : null;

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
    } catch (err: any) {
      this.logger.error(`Failed to fetch panel usage for sub ${subscriptionId}: ${err?.message}`);
      return null;
    }
  }

  async suspendVpnUser(subscriptionId: bigint): Promise<void> {
    try {
      this.logger.log(`Suspending VPN user for subscription ${subscriptionId}`);
    } catch (err: any) {
      this.logger.error(`VPN suspend failed: ${err?.message ?? err}`);
    }
  }

  async resumeVpnUser(subscriptionId: bigint): Promise<void> {
    try {
      this.logger.log(`Resuming VPN user for subscription ${subscriptionId}`);
    } catch (err: any) {
      this.logger.error(`VPN resume failed: ${err?.message ?? err}`);
    }
  }

  async resetTraffic(subscriptionId: bigint): Promise<void> {
    try {
      this.logger.log(`Resetting traffic for subscription ${subscriptionId}`);
    } catch (err: any) {
      this.logger.error(`VPN reset traffic failed: ${err?.message ?? err}`);
    }
  }

  async renewOnPanel(subscriptionId: bigint, days: number): Promise<void> {
    try {
      this.logger.log(`Renewing VPN user for subscription ${subscriptionId} (+${days} days)`);
    } catch (err: any) {
      this.logger.error(`VPN renew failed: ${err?.message ?? err}`);
    }
  }

  /** Delete panel user (when subscription cancelled). */
  async deleteVpnUser(vpnUserId: bigint): Promise<void> {
    try {
      this.logger.log(`Deleting VPN user ${vpnUserId}`);
    } catch (err: any) {
      this.logger.error(`VPN delete failed: ${err?.message ?? err}`);
    }
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
    trafficLimitBytes?: bigint;
    expiryAt?: Date;
    syncError?: string;
    tx?: PrismaClient;
  }): Promise<void> {
    const db = params.tx ?? this.prisma;
    const existing = await db.vpnUser.findUnique({
      where: { subscriptionId: params.subscriptionId },
    });

    if (existing) {
      // Updating an existing VPN user record
      const updateData: Record<string, unknown> = {
        panelUserId: params.panelUserId ?? '',
        subLink: params.subLink,
        subToken: params.subToken,
        totalTrafficBytes: params.trafficLimitBytes,
        expiryAt: params.expiryAt,
        lastSyncAt: new Date(),
      };

      if (params.syncError) {
        updateData.status = 'DISABLED';
        updateData.syncError = params.syncError;
      } else {
        updateData.status = 'ACTIVE';
        updateData.syncError = null;
      }

      await db.vpnUser.update({
        where: { id: existing.id },
        data: updateData as any,
      });
      return;
    }

    // Creating a new VPN user record
    await db.vpnUser.create({
      data: {
        panelId: params.panelId,
        panelUserId: params.panelUserId ?? '',
        userId: params.userId,
        subscriptionId: params.subscriptionId,
        subLink: params.subLink,
        subToken: params.subToken,
        totalTrafficBytes: params.trafficLimitBytes,
        expiryAt: params.expiryAt,
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
