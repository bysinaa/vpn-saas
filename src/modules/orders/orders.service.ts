import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { fromMinor, toMinor, type MinorUnits } from '@/common/utils/money.util';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import { VpnService } from '../vpn/vpn.service';
import { randomUUID } from 'node:crypto';
import type { OrderStatus, OrderType, PaymentMethod, Prisma } from '@prisma/client';

export interface OrderDto {
  id: string;
  publicId: string;
  status: OrderStatus;
  type: OrderType;
  planId: string;
  planName: string;
  unitPrice: string;
  quantity: number;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  currency: string;
  paymentMethod: PaymentMethod | null;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * OrdersService - orchestrates the purchase pipeline:
 *  create -> pay -> complete -> provision subscription
 *
 * Wallet payments are settled immediately; external gateways create a Payment
 * row and are confirmed via callbacks/jobs.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly subscriptions: SubscriptionsService,
    private readonly vpn: VpnService,
  ) {}

  async create(input: {
    userId: bigint;
    planPublicId: string;
    type?: OrderType;
    targetSubscriptionPublicId?: string;
    quantity?: number;
    giftForUserId?: bigint;
    paymentMethod?: PaymentMethod;
  }): Promise<OrderDto> {
    const plan = await this.plans.getRaw(input.planPublicId);
    if (plan.status !== 'ACTIVE' || !plan.isEnabled)
      throw BusinessException.conflict('Plan is not available');
    if (plan.type === 'TRIAL')
      throw BusinessException.conflict('Trial plans are created via /trials endpoint');

    const type = input.type ?? 'NEW';
    if ((type === 'RENEW' || type === 'EXTEND') && input.quantity && input.quantity !== 1) {
      throw BusinessException.conflict('Renewal orders must have quantity one');
    }
    let targetSubscriptionId: bigint | null = null;
    if (type === 'RENEW' || type === 'EXTEND') {
      if (!input.targetSubscriptionPublicId) {
        throw BusinessException.conflict('A subscription is required for renewal');
      }
      const target = await this.prisma.subscription.findUnique({
        where: { publicId: input.targetSubscriptionPublicId },
        include: { plan: true },
      });
      if (!target) throw BusinessException.notFound('Subscription not found');
      if (target.userId !== input.userId)
        throw BusinessException.forbidden('Not your subscription');
      if (target.planId !== plan.id)
        throw BusinessException.conflict('Renewal plan does not match');
      if (!target.plan.isRenewable) throw BusinessException.conflict('Plan is not renewable');
      targetSubscriptionId = target.id;
    }

    const unitPrice = this.plans.priceMinor(plan);
    const quantity = input.quantity ?? 1;
    const totalAmount = unitPrice * BigInt(quantity);

    const order = await this.prisma.order.create({
      data: {
        publicId: randomUUID(),
        userId: input.userId,
        planId: plan.id,
        type,
        status: 'PENDING',
        unitPrice,
        quantity,
        discountAmount: plan.price - unitPrice,
        taxAmount: 0n,
        totalAmount,
        currency: plan.currency,
        paymentMethod: input.paymentMethod ?? null,
        subscriptionId: targetSubscriptionId,
        giftForUserId: input.giftForUserId ?? null,
      },
      include: { plan: true },
    });
    return this.toDto(order);
  }

  async completeOrderInTransaction(
    tx: Prisma.TransactionClient,
    orderId: bigint,
    userId: bigint,
  ): Promise<{ order: OrderDto; subscription: any; provisioningRequired: boolean }> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { plan: true },
    });
    if (!order) throw BusinessException.notFound('Order not found');
    if (order.status === 'COMPLETED') {
      const subscription = order.subscriptionId
        ? await tx.subscription.findUnique({
            where: { id: order.subscriptionId },
            include: { plan: true },
          })
        : await tx.subscription.findUnique({
            where: { orderId: order.id },
            include: { plan: true },
          });
      return {
        order: this.toDto(order),
        subscription,
        provisioningRequired: false,
      };
    }

    const claim = await tx.order.updateMany({
      where: { id: orderId, status: 'PENDING' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    if (claim.count === 0) {
      const completed = await tx.order.findUnique({
        where: { id: orderId },
        include: { plan: true },
      });
      if (!completed) throw BusinessException.notFound('Order not found');
      if (completed.status !== 'COMPLETED') {
        throw BusinessException.conflict('Order is not payable');
      }
      const subscription = completed.subscriptionId
        ? await tx.subscription.findUnique({
            where: { id: completed.subscriptionId },
            include: { plan: true },
          })
        : await tx.subscription.findUnique({
            where: { orderId: completed.id },
            include: { plan: true },
          });
      return {
        order: this.toDto(completed),
        subscription,
        provisioningRequired: false,
      };
    }

    const updated = await tx.order.findUnique({
      where: { id: orderId },
      include: { plan: true },
    });
    if (!updated) throw BusinessException.notFound('Order not found');
    const provisioningTarget = await this.vpn.selectProvisioningTarget(updated.plan, tx);
    const subscription = await this.subscriptions.provisionInTransaction({
      userId,
      planId: order.planId,
      orderId: order.id,
      type: order.type,
      isTrial: order.plan.isTrial,
      provisioningTarget,
      targetSubscriptionId: updated.subscriptionId ?? undefined,
      tx,
    });

    if (updated.subscriptionId !== subscription.id) {
      await tx.order.update({
        where: { id: updated.id },
        data: { subscriptionId: subscription.id },
      });
    }

    await this.creditReferralCommission(tx, updated);

    return {
      order: this.toDto(updated),
      subscription,
      provisioningRequired: true,
    };
  }

  private async creditReferralCommission(tx: Prisma.TransactionClient, order: any): Promise<void> {
    if (order.totalAmount <= 0n) return;
    const referred = await tx.user.findUnique({
      where: { id: order.userId },
      select: { referredById: true },
    });
    if (!referred?.referredById) return;

    const settings = new Map(
      (
        await tx.systemSetting.findMany({
          where: {
            key: {
              in: ['referral.enabled', 'referral.commissionPercent', 'referral.maxBonus'],
            },
          },
          select: { key: true, value: true },
        })
      ).map((setting) => [setting.key, setting.value]),
    );
    if (settings.get('referral.enabled') === 'false') return;
    const percent = Math.trunc(Number(settings.get('referral.commissionPercent') ?? '0'));
    if (percent <= 0 || percent > 100) return;

    let commission = (order.totalAmount * BigInt(percent)) / 100n;
    const maxBonus = BigInt(settings.get('referral.maxBonus') ?? '0');
    if (maxBonus > 0n) {
      const earned = await tx.walletTransaction.aggregate({
        where: { wallet: { userId: referred.referredById }, type: 'REFERRAL_REWARD' },
        _sum: { amount: true },
      });
      commission = [commission, maxBonus - (earned._sum.amount ?? 0n)].reduce((a, b) =>
        a < b ? a : b,
      );
    }
    if (commission <= 0n) return;

    const wallet = await tx.wallet.upsert({
      where: { userId: referred.referredById },
      update: {},
      create: { userId: referred.referredById },
    });
    const updatedWallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: commission } },
    });
    await tx.walletTransaction.create({
      data: {
        publicId: randomUUID(),
        walletId: wallet.id,
        type: 'REFERRAL_REWARD',
        status: 'CONFIRMED',
        amount: commission,
        balanceBefore: updatedWallet.balance - commission,
        balanceAfter: updatedWallet.balance,
        description: `Referral commission for order ${order.publicId}`,
        reference: `referral-order-${order.publicId}`,
        orderId: order.id,
        metadata: { referredUserId: order.userId.toString(), rate: percent } as any,
      },
    });
    await tx.referralLog.updateMany({
      where: {
        referrerId: referred.referredById,
        referredId: order.userId,
        status: 'PENDING',
      },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
  }

  async cancel(orderPublicId: string, userId: bigint): Promise<OrderDto> {
    const order = await this.getOwnedOrder(orderPublicId, userId);
    if (order.status === 'COMPLETED')
      throw BusinessException.conflict('Cannot cancel completed order');
    if (order.status === 'CANCELLED') return this.toDto(order);
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
      include: { plan: true },
    });
    return this.toDto(updated);
  }

  async findOne(orderPublicId: string, userId: bigint): Promise<OrderDto> {
    const order = await this.getOwnedOrder(orderPublicId, userId);
    return this.toDto(order);
  }

  async listMine(userId: bigint, query: Record<string, unknown>): Promise<PaginatedDto<OrderDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = { userId };
    if (query.status) where.status = query.status;
    const [total, items] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        ...skipTake(params),
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      }),
    ]);
    return { data: items.map(this.toDto), meta: buildMeta(total, params) };
  }

  async listAll(query: Record<string, unknown>): Promise<PaginatedDto<OrderDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.userId) where.userId = BigInt(query.userId as string);
    const [total, items] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        ...skipTake(params),
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      }),
    ]);
    return { data: items.map(this.toDto), meta: buildMeta(total, params) };
  }

  private async getOwnedOrder(publicId: string, userId: bigint) {
    const order = await this.prisma.order.findUnique({
      where: { publicId },
      include: { plan: true },
    });
    if (!order) throw BusinessException.notFound('Order not found');
    if (order.userId !== userId) throw BusinessException.forbidden('Not your order');
    return order;
  }

  private toDto(o: any): OrderDto {
    return {
      id: o.id.toString(),
      publicId: o.publicId,
      status: o.status,
      type: o.type,
      planId: o.planId.toString(),
      planName: o.plan?.name ?? '',
      unitPrice: fromMinor(o.unitPrice),
      quantity: o.quantity,
      discountAmount: fromMinor(o.discountAmount),
      taxAmount: fromMinor(o.taxAmount),
      totalAmount: fromMinor(o.totalAmount),
      currency: o.currency,
      paymentMethod: o.paymentMethod,
      createdAt: o.createdAt,
      completedAt: o.completedAt ?? null,
    };
  }
}
