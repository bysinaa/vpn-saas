import { Injectable, forwardRef, Inject, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import type { PrismaClient, SubscriptionStatus, PlanType } from '@prisma/client';
import { VpnService } from '../vpn/vpn.service';
import type { OrderType } from '@prisma/client';

export interface SubscriptionDto {
  id: string;
  publicId: string;
  status: SubscriptionStatus;
  type: PlanType;
  trafficLimitBytes: string | null;
  usedTrafficBytes: string;
  durationDays: number | null;
  startsAt: Date;
  expiresAt: Date | null;
  deviceLimit: number;
  activeDevices: number;
  subscriptionLink: string | null;
  isTrial: boolean;
  planId: string;
  planName: string;
  createdAt: Date;
}

/**
 * SubscriptionsService - provisions and manages VPN subscriptions.
 * provisioning delegates to VpnService to create the panel user + sub link.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => VpnService))
    private readonly vpn: VpnService,
  ) {}

  /**
   * Provision a new (or renewed) subscription within an existing transaction.
   * Safe to call inside OrdersService.completeOrder's tx.
   */
  async provision(params: {
    userId: bigint;
    planId: bigint;
    orderId?: bigint;
    type: OrderType;
    isTrial?: boolean;
    tx?: PrismaClient;
  }): Promise<SubscriptionDto> {
    const db = params.tx ?? this.prisma;
    const plan = await db.plan.findUnique({ where: { id: params.planId } });
    if (!plan) throw BusinessException.notFound('Plan not found');

    const startsAt = new Date();
    const expiresAt = plan.durationDays
      ? new Date(startsAt.getTime() + plan.durationDays * 24 * 3600 * 1000)
      : null;
    const trafficLimitBytes = plan.trafficLimitGb ? plan.trafficLimitGb * 1024n * 1024n * 1024n : null;

    // For renewals/extends, find existing active sub
    const existing = await db.subscription.findFirst({
      where: { userId: params.userId, planId: plan.id, status: { in: ['ACTIVE', 'PAUSED', 'TRIAL'] } },
    });

    let subscription: any;
    if (existing && (params.type === 'RENEW' || params.type === 'EXTEND')) {
      const newExpiry = existing.expiresAt
        ? new Date(Math.max(existing.expiresAt.getTime(), Date.now()) + (plan.durationDays ?? 0) * 86400000)
        : expiresAt;
      subscription = await db.subscription.update({
        where: { id: existing.id },
        data: {
          expiresAt: newExpiry,
          trafficLimitBytes: trafficLimitBytes ?? existing.trafficLimitBytes,
          status: 'ACTIVE',
        },
        include: { plan: true },
      });
      await db.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          event: params.type,
          // Prisma Json fields reject bigint; serialize as string.
          payload: { orderId: params.orderId?.toString() ?? null } as any,
        },
      });
    } else {
      subscription = await db.subscription.create({
        data: {
          publicId: crypto.randomUUID(),
          userId: params.userId,
          planId: plan.id,
          orderId: params.orderId ?? null,
          status: params.isTrial ? 'TRIAL' : 'ACTIVE',
          type: plan.type,
          trafficLimitBytes,
          usedTrafficBytes: 0n,
          durationDays: plan.durationDays,
          startsAt,
          expiresAt,
          deviceLimit: plan.deviceLimit,
          isTrial: params.isTrial ?? plan.isTrial,
        },
        include: { plan: true },
      });
      await db.subscriptionEvent.create({
        data: {
          subscriptionId: subscription.id,
          event: 'CREATED',
          payload: { orderId: params.orderId?.toString() ?? null } as any,
        },
      });
    }

    // Provision VPN user on the 3x-UI panel.
    // If VPN creation fails, log but don't break subscription creation.
    // The queue worker will retry later.
    try {
      await this.vpn.createVpnUserForSubscription(subscription.id);
    } catch (err: any) {
      this.logger.error(
        `VPN provisioning failed for sub ${subscription.id} (will be retried): ${err?.message ?? err}`,
        err?.stack,
      );
    }

    return this.toDto(subscription);
  }

  async getById(id: bigint): Promise<SubscriptionDto> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      include: { plan: true },
    });
    if (!sub) throw BusinessException.notFound('Subscription not found');
    return this.toDto(sub);
  }

  async listMine(userId: bigint, query: Record<string, unknown>): Promise<PaginatedDto<SubscriptionDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = { userId };
    if (query.status) where.status = query.status;
    const [total, items] = await Promise.all([
      this.prisma.subscription.count({ where }),
      this.prisma.subscription.findMany({
        where,
        ...skipTake(params),
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      }),
    ]);
    return { data: items.map(this.toDto), meta: buildMeta(total, params) };
  }

  async listAll(query: Record<string, unknown>): Promise<PaginatedDto<SubscriptionDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.userId) where.userId = BigInt(query.userId as string);
    const [total, items] = await Promise.all([
      this.prisma.subscription.count({ where }),
      this.prisma.subscription.findMany({
        where,
        ...skipTake(params),
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      }),
    ]);
    return { data: items.map(this.toDto), meta: buildMeta(total, params) };
  }

  async renew(publicId: string, userId: bigint): Promise<SubscriptionDto> {
    const sub = await this.getOwned(publicId, userId);
    if (!sub.plan.isRenewable) throw BusinessException.conflict('Plan is not renewable');
    return this.toDto(
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'ACTIVE',
          expiresAt: new Date(
            Math.max(sub.expiresAt?.getTime() ?? Date.now(), Date.now()) +
              (sub.plan.durationDays ?? 30) * 86400000,
          ),
        },
        include: { plan: true },
      }),
    );
  }

  async suspend(publicId: string, userId: bigint): Promise<SubscriptionDto> {
    const sub = await this.getOwned(publicId, userId);
    await this.vpn.suspendVpnUser(sub.id);
    return this.toDto(
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'SUSPENDED' },
        include: { plan: true },
      }),
    );
  }

  async resume(publicId: string, userId: bigint): Promise<SubscriptionDto> {
    const sub = await this.getOwned(publicId, userId);
    await this.vpn.resumeVpnUser(sub.id);
    return this.toDto(
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'ACTIVE' },
        include: { plan: true },
      }),
    );
  }

  async pause(publicId: string, userId: bigint): Promise<SubscriptionDto> {
    const sub = await this.getOwned(publicId, userId);
    if (!sub.plan.allowPause) throw BusinessException.conflict('Plan does not allow pausing');
    return this.toDto(
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'PAUSED', pausedAt: new Date() },
        include: { plan: true },
      }),
    );
  }

  async resetTraffic(publicId: string, userId: bigint): Promise<SubscriptionDto> {
    const sub = await this.getOwned(publicId, userId);
    await this.vpn.resetTraffic(sub.id);
    return this.toDto(
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { usedTrafficBytes: 0n },
        include: { plan: true },
      }),
    );
  }

  async extend(publicId: string, userId: bigint, days: number): Promise<SubscriptionDto> {
    const sub = await this.getOwned(publicId, userId);
    const base = Math.max(sub.expiresAt?.getTime() ?? Date.now(), Date.now());
    return this.toDto(
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { expiresAt: new Date(base + days * 86400000) },
        include: { plan: true },
      }),
    );
  }

  async transfer(publicId: string, fromUserId: bigint, toUserId: bigint): Promise<SubscriptionDto> {
    const sub = await this.getOwned(publicId, fromUserId);
    if (!sub.plan.isTransferable) throw BusinessException.conflict('Plan is not transferable');
    const target = await this.prisma.user.findUnique({ where: { id: toUserId } });
    if (!target) throw BusinessException.notFound('Target user not found');
    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { userId: toUserId },
      include: { plan: true },
    });
    await this.prisma.subscriptionEvent.create({
      data: { subscriptionId: sub.id, event: 'TRANSFER', payload: { from: fromUserId.toString(), to: toUserId.toString() } },
    });
    return this.toDto(updated);
  }

  /** Bulk expiry check (called by scheduler). */
  async markExpired(): Promise<number> {
    const result = await this.prisma.subscription.updateMany({
      where: { status: { in: ['ACTIVE', 'TRIAL'] }, expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }

  private async getOwned(publicId: string, userId: bigint) {
    const sub = await this.prisma.subscription.findUnique({
      where: { publicId },
      include: { plan: true },
    });
    if (!sub) throw BusinessException.notFound('Subscription not found');
    if (sub.userId !== userId) throw BusinessException.forbidden('Not your subscription');
    return sub;
  }

  private toDto(s: any): SubscriptionDto {
    return {
      id: s.id.toString(),
      publicId: s.publicId,
      status: s.status,
      type: s.type,
      trafficLimitBytes: s.trafficLimitBytes != null ? s.trafficLimitBytes.toString() : null,
      usedTrafficBytes: s.usedTrafficBytes.toString(),
      durationDays: s.durationDays,
      startsAt: s.startsAt,
      expiresAt: s.expiresAt,
      deviceLimit: s.deviceLimit,
      activeDevices: s.activeDevices,
      subscriptionLink: s.subscriptionLink ?? null,
      isTrial: s.isTrial,
      planId: s.planId.toString(),
      planName: s.plan?.name ?? '',
      createdAt: s.createdAt,
    };
  }
}