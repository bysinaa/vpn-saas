import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
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
import type { OrderStatus, OrderType, PaymentMethod } from '@prisma/client';

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
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly plans: PlansService,
    private readonly subscriptions: SubscriptionsService,
    private readonly vpn: VpnService,
  ) {}

  async create(input: {
    userId: bigint;
    planPublicId: string;
    type?: OrderType;
    quantity?: number;
    giftForUserId?: bigint;
    paymentMethod?: PaymentMethod;
  }): Promise<OrderDto> {
    const plan = await this.plans.getRaw(input.planPublicId);
    if (plan.status !== 'ACTIVE') throw BusinessException.conflict('Plan is not available');
    if (plan.type === 'TRIAL') throw BusinessException.conflict('Trial plans are created via /trials endpoint');

    const unitPrice = this.plans.priceMinor(plan);
    const quantity = input.quantity ?? 1;
    const totalAmount = unitPrice * BigInt(quantity);

    const order = await this.prisma.order.create({
      data: {
        publicId: randomUUID(),
        userId: input.userId,
        planId: plan.id,
        type: input.type ?? 'NEW',
        status: 'PENDING',
        unitPrice,
        quantity,
        discountAmount: plan.price - unitPrice,
        taxAmount: 0n,
        totalAmount,
        currency: plan.currency,
        paymentMethod: input.paymentMethod ?? null,
        giftForUserId: input.giftForUserId ?? null,
      },
      include: { plan: true },
    });
    return this.toDto(order);
  }

  /** Pay with wallet balance: deducts funds, completes order, provisions sub. */
  async payWithWallet(orderPublicId: string, userId: bigint): Promise<{ order: OrderDto; subscription: any }> {
    const order = await this.getOwnedOrder(orderPublicId, userId);
    if (order.status !== 'PENDING') throw BusinessException.conflict('Order is not payable');

    // Debit wallet (throws on insufficient funds)
    await this.wallet.debit(userId, order.totalAmount, 'PURCHASE', {
      description: `Purchase: ${order.plan.name}`,
      reference: order.publicId,
      orderId: order.id,
    });

    // Mark order paid + create confirmed payment
    await this.prisma.payment.create({
      data: {
        publicId: randomUUID(),
        orderId: order.id,
        userId,
        method: 'WALLET',
        status: 'CONFIRMED',
        amount: order.totalAmount,
        currency: order.currency,
        confirmedAt: new Date(),
      },
    });

    return this.completeOrder(order.id, userId);
  }

  /**
   * Called by payment callbacks/jobs once a payment is confirmed.
   * Marks order completed and provisions the subscription.
   */
  async completeOrder(orderId: bigint, userId: bigint): Promise<{ order: OrderDto; subscription: any }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { plan: true },
    });
    if (!order) throw BusinessException.notFound('Order not found');
    if (order.status === 'COMPLETED') {
      // idempotent: return existing subscription
      const sub = order.subscriptionId
        ? await this.subscriptions.getById(order.subscriptionId)
        : null;
      return { order: this.toDto(order), subscription: sub };
    }

    const result = await this.prisma.withTransaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: 'COMPLETED', completedAt: new Date() },
        include: { plan: true },
      });

      const sub = await this.subscriptions.provision({
        userId,
        planId: order.planId,
        orderId: order.id,
        type: order.type,
        isTrial: order.plan.isTrial,
        tx,
      });

      return { order: this.toDto(updated), subscription: sub };
    });

    return result;
  }

  async cancel(orderPublicId: string, userId: bigint): Promise<OrderDto> {
    const order = await this.getOwnedOrder(orderPublicId, userId);
    if (order.status === 'COMPLETED') throw BusinessException.conflict('Cannot cancel completed order');
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
