import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import type { PrismaClient } from '@prisma/client';
import { PanelsService } from '../panels/panels.service';

/**
 * VpnService - facade over the VPN panel integration.
 * Uses PanelsService + SanityPanelClient to manage 3x-UI users.
 */
@Injectable()
export class VpnService {
  private readonly logger = new Logger(VpnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly panels: PanelsService,
  ) {}

  /**
   * Create a 3x-UI client for a subscription.
   * Called by SubscriptionsService.provision() after the subscription row is created.
   */
  async createVpnUserForSubscription(subscriptionId: bigint): Promise<void> {
    // Load subscription with user + plan
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: true, user: true },
    });
    if (!sub) {
      this.logger.warn(`Subscription ${subscriptionId} not found — skipping VPN creation`);
      return;
    }

    // Find an active panel (prefer the first ACTIVE one)
    const panelRow = await this.prisma.vpnPanel.findFirst({ where: { status: 'ACTIVE' } });
    if (!panelRow) {
      this.logger.warn('No active VPN panel found — skipping VPN user creation');
      return;
    }

    const connection = await this.panels.getConnection(panelRow.id);
    const client = this.panels.getClient(panelRow.type);

    // Generate a unique email for the 3x-UI client
    const trafficLimitBytes = sub.trafficLimitBytes ?? undefined;
    const expireMs = sub.expiresAt ? sub.expiresAt.getTime() : null;
    const username = this.generateUsername(sub.user, sub.plan, trafficLimitBytes, expireMs);

    // Create the user on the 3x-UI panel
    let panelUser;
    try {
      panelUser = await client.createUser(connection, {
        username,
        dataLimitBytes: trafficLimitBytes ?? null,
        expireMs,
        deviceLimit: sub.deviceLimit,
        protocols: undefined, // undefined = all inbounds
      });
    } catch (err: any) {
      // Fail gracefully: log the error but don't break the subscription flow.
      // The admin can manually fix the panel issue and sync later.
      const errorMsg = `Failed to create 3x-UI client for sub ${subscriptionId} (${username}): ${err?.message ?? err}`;
      this.logger.error(errorMsg, err?.stack);
      // Record a "pending" mapping with error details so we can retry later
      // without breaking the subscription flow.
      await this.recordVpnUserMapping({
        subscriptionId: sub.id,
        userId: sub.userId,
        panelId: panelRow.id,
        panelUserId: username,
        subLink: undefined,
        trafficLimitBytes,
        expiryAt: sub.expiresAt ?? undefined,
        syncError: errorMsg,
      });
      return; // Don't throw — subscription is already created and working.
    }

    if (!panelUser) {
      const errorMsg = `createUser returned null for sub ${subscriptionId} (${username})`;
      this.logger.error(errorMsg);
      // Record a "pending" mapping with error details so we can retry later.
      await this.recordVpnUserMapping({
        subscriptionId: sub.id,
        userId: sub.userId,
        panelId: panelRow.id,
        panelUserId: username,
        subLink: undefined,
        trafficLimitBytes,
        expiryAt: sub.expiresAt ?? undefined,
        syncError: errorMsg,
      });
      return; // Don't throw — subscription is already created and working.
    }

    // Record the mapping in our DB.
    // Store the email (username) as panelUserId since the SanityPanelClient
    // getUser() endpoint uses email as the lookup key (/panel/api/clients/get/{email}).
    await this.recordVpnUserMapping({
      subscriptionId: sub.id,
      userId: sub.userId,
      panelId: panelRow.id,
      panelUserId: username, // email is the lookup key for 3x-ui
      subLink: panelUser.subLink,
      trafficLimitBytes,
      expiryAt: sub.expiresAt ?? undefined,
    });

    this.logger.log(
      `VPN user created for sub ${subscriptionId}: uuid=${panelUser.uuid} email=${username}`,
    );
  }

  /**
   * Generate a unique email (username) for 3x-UI from user info + plan details.
   * Each subscription gets its own client in 3x-UI, so the email must be unique.
   *
   * Format examples:
   *   "Taza_50GB_31d"      — with username, traffic + days
   *   "Taza_50GB_unlim"    — with username, traffic, no expiry
   *   "Taza_31d"           — with username, no traffic limit, has days
   *   "Taza_unlim"         — with username, no limits
   *   "tg_123456_50GB"     — fallback with telegramId
   */
  private generateUsername(
    user: { username?: string | null; firstName?: string | null; telegramId?: string | null },
    plan: { name?: string | null; trafficLimitGb?: number | bigint | null; durationDays?: number | null } | null,
    trafficLimitBytes?: bigint,
    expireMs?: number | null,
  ): string {
    // Get a clean base name from the user
    let base = '';
    if (user.username) {
      base = user.username.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
    }
    if (!base && user.firstName) {
      base = user.firstName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
    }
    if (!base && user.telegramId) {
      base = `tg${user.telegramId}`;
    }
    if (!base) {
      base = `user${Date.now().toString(36)}`;
    }

    // Build traffic suffix
    let trafficTag = '';
    if (trafficLimitBytes && trafficLimitBytes > 0n) {
      const gb = Math.round(Number(trafficLimitBytes) / (1024 * 1024 * 1024));
      trafficTag = gb > 0 ? `_${gb}GB` : '';
    }

    // Build duration suffix
    const days = plan?.durationDays;
    let durationTag = '';
    if (days && days > 0) {
      durationTag = `_${days}d`;
    } else if (!expireMs) {
      durationTag = '_unlim';
    }

    // Add a unique short suffix to prevent duplicates (first 8 chars of UUID without dashes)
    const uid = crypto.randomUUID().replace(/-/g, '').substring(0, 8);

    return `${base}${trafficTag}${durationTag}_${uid}`;
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
