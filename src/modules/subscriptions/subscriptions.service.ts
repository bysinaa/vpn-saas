import { Injectable, forwardRef, Inject } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import type { Prisma, SubscriptionStatus, PlanType } from '@prisma/client';
import { VpnService } from '../vpn/vpn.service';
import type { XuiProvisioningTarget } from '../vpn/vpn.service';
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
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => VpnService))
    private readonly vpn: VpnService,
  ) {}

  async provisionInTransaction(params: {
    userId: bigint;
    planId: bigint;
    orderId?: bigint;
    type: OrderType;
    isTrial?: boolean;
    provisioningTarget?: XuiProvisioningTarget;
    targetSubscriptionId?: bigint;
    tx: Prisma.TransactionClient;
  }): Promise<any> {
    const db = params.tx;
    const plan = await db.plan.findUnique({ where: { id: params.planId } });
    if (!plan) throw BusinessException.notFound('Plan not found');

    const startsAt = new Date();
    const expiresAt = plan.durationDays
      ? new Date(startsAt.getTime() + plan.durationDays * 24 * 3600 * 1000)
      : null;
    const trafficLimitBytes =
      (plan as typeof plan & { trafficLimitBytes?: bigint | null }).trafficLimitBytes ??
      (plan.trafficLimitGb ? plan.trafficLimitGb * 1024n * 1024n * 1024n : null);

    const existing = params.targetSubscriptionId
      ? await db.subscription.findUnique({ where: { id: params.targetSubscriptionId } })
      : null;

    if (params.type === 'RENEW' || params.type === 'EXTEND') {
      if (!existing) throw BusinessException.notFound('Renewal subscription not found');
      if (existing.userId !== params.userId)
        throw BusinessException.forbidden('Not your subscription');
      if (existing.planId !== plan.id)
        throw BusinessException.conflict('Renewal plan does not match');
    }

    let subscription: any;
    if (existing && (params.type === 'RENEW' || params.type === 'EXTEND')) {
      const newExpiry = plan.durationDays
        ? new Date(
            Math.max(existing.expiresAt?.getTime() ?? 0, Date.now()) + plan.durationDays * 86400000,
          )
        : null;
      subscription = await db.subscription.update({
        where: { id: existing.id },
        data: {
          expiresAt: newExpiry,
          trafficLimitBytes,
          durationDays: plan.durationDays,
          deviceLimit: plan.deviceLimit,
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
          ...(params.provisioningTarget
            ? {
                provisioningPanelId: params.provisioningTarget.panelId,
                provisioningInboundIds: params.provisioningTarget.inboundIds,
              }
            : {}),
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

    return subscription;
  }

  async provision(params: {
    userId: bigint;
    planId: bigint;
    orderId?: bigint;
    type: OrderType;
    isTrial?: boolean;
    tx?: Prisma.TransactionClient;
  }): Promise<SubscriptionDto> {
    const subscription = params.tx
      ? await this.provisionInTransaction({ ...params, tx: params.tx })
      : await this.prisma.withTransaction((tx) => this.provisionInTransaction({ ...params, tx }));

    if (params.tx) return this.toDto(subscription);

    await this.vpn.createVpnUserForSubscription(subscription.id);

    return this.getById(subscription.id);
  }

  async getById(id: bigint): Promise<SubscriptionDto> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      include: { plan: true },
    });
    if (!sub) throw BusinessException.notFound('Subscription not found');
    return this.toDto(sub);
  }

  async listMine(
    userId: bigint,
    query: Record<string, unknown>,
  ): Promise<PaginatedDto<SubscriptionDto>> {
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

  async suspend(publicId: string, userId: bigint): Promise<SubscriptionDto> {
    const sub = await this.getOwned(publicId, userId);
    await this.vpn.suspendVpnUser(sub.id);
    return this.getById(sub.id);
  }

  async resume(publicId: string, userId: bigint): Promise<SubscriptionDto> {
    const sub = await this.getOwned(publicId, userId);
    await this.vpn.resumeVpnUser(sub.id);
    return this.getById(sub.id);
  }

  async resetTraffic(publicId: string, userId: bigint): Promise<SubscriptionDto> {
    const sub = await this.getOwned(publicId, userId);
    await this.vpn.resetTraffic(sub.id);
    return this.getById(sub.id);
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
      data: {
        subscriptionId: sub.id,
        event: 'TRANSFER',
        payload: { from: fromUserId.toString(), to: toUserId.toString() },
      },
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
