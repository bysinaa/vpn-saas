import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { OrdersService } from '../orders/orders.service';
import { AuditService } from '@/common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { config } from '@/config';
import { hashToken } from '@/common/utils/crypto.util';
import { fromMinor } from '@/common/utils/money.util';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import { randomUUID } from 'node:crypto';
import type {
  Payment,
  PaymentMethod,
  ReceiptStatus,
  CryptoCurrency,
} from '@prisma/client';
import { QUEUES, JOB_NAMES } from '@/common/queue/queue-names';
import {
  PAYMENT_GATEWAYS,
  type IPaymentGateway,
} from './payment-gateway.interface';

export interface PaymentDto {
  id: string;
  publicId: string;
  orderId: string | null; // null for standalone wallet top-ups (spec #7)
  method: PaymentMethod;
  status: string;
  amount: string;
  currency: string;
  gateway?: string | null;
  gatewayTransactionId?: string | null;
  redirectUrl?: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
}

/**
 * Default online gateway code. Override by registering additional gateways
 * and changing this constant (or sourcing from SystemSetting).
 */
const DEFAULT_ONLINE_GATEWAY_CODE = 'zarinpal';

export interface ReceiptDto {
  id: string;
  publicId: string;
  paymentPublicId: string;
  status: ReceiptStatus;
  payerName: string;
  cardNumber: string | null;
  fileKey: string;
  amount: string | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  // User info (for admin panel display)
  userId?: string | null;
  userName?: string | null;
  userTelegramId?: string | null;
}

/**
 * PaymentsService - orchestrates every payment method:
 *  - ONLINE: delegates to a pluggable IPaymentGateway, verifies on callback
 *  - CARD_TO_CARD: user uploads receipt, admin verifies
 *  - CRYPTO: address generated, verified via job/webhook
 *  - WALLET: handled by OrdersService.payWithWallet (instant)
 *  - VOUCHER: redeem code -> credit wallet or pay order
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(PAYMENT_GATEWAYS) private readonly gateways: Map<string, IPaymentGateway>,
  ) {}

  /** Initiate a wallet deposit (not tied to an order). */
  async initiateWalletDeposit(userId: bigint, amount: string, cryptoCurrency?: string): Promise<PaymentDto> {
    const payment = await this.prisma.payment.create({
      data: {
        publicId: randomUUID(),
        userId,
        method: cryptoCurrency ? 'CRYPTO' : 'CARD_TO_CARD',
        status: 'PENDING',
        amount: BigInt(amount.replace(/[^0-9]/g, '')) || 0n,
        currency: cryptoCurrency ?? 'IRR',
      },
    });
    return this.toDto(payment);
  }

  /** Initiate a payment for an order using the chosen method. */
  async initiate(input: {
    userId: bigint;
    orderPublicId: string;
    method: PaymentMethod;
    cryptoCurrency?: CryptoCurrency;
    voucherCode?: string;
  }): Promise<PaymentDto> {
    const order = await this.orders.findOne(input.orderPublicId, input.userId);
    if (order.status !== 'PENDING') {
      throw BusinessException.conflict('Order is not payable');
    }

    // VOUCHER: redeem immediately and settle the order
    if (input.method === 'VOUCHER') {
      return this.payWithVoucher(input.orderPublicId, input.userId, input.voucherCode!);
    }

    const payment = await this.prisma.payment.create({
      data: {
        publicId: randomUUID(),
        orderId: BigInt(order.id),
        userId: input.userId,
        method: input.method,
        status: 'PENDING',
        amount: BigInt(order.totalAmount.replace(/[^0-9]/g, '')) || 0n,
        currency: order.currency,
      },
    });

    if (input.method === 'ONLINE') {
      const gatewayCode = DEFAULT_ONLINE_GATEWAY_CODE;
      const gateway = this.gateways.get(gatewayCode);
      if (!gateway) throw BusinessException.conflict(`Gateway '${gatewayCode}' not configured`);
      const result = await gateway.initiate({
        paymentId: payment.id,
        amountMinor: payment.amount,
        currency: payment.currency,
        description: `Order ${order.publicId}`,
        callbackUrl: `${config.app.url}/payments/online/callback`,
        userPublicId: order.publicId,
      });
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          gateway: gateway.code,
          gatewayRef: result.gatewayTransactionId,
          metadata: { redirectUrl: result.redirectUrl } as any,
        },
      });
      return this.toDto({ ...payment, gateway: gateway.code, gatewayRef: result.gatewayTransactionId });
    }

    if (input.method === 'CARD_TO_CARD') {
      // Attach the merchant card info from settings; user uploads receipt next
      const cardInfo = await this.prisma.systemSetting.findUnique({
        where: { key: 'payment.card_to_card.details' },
      });
      return this.toDto({
        ...payment,
        metadata: { merchantCard: cardInfo?.value ?? null },
      });
    }

    if (input.method === 'CRYPTO') {
      // CryptoCurrency enum: USDT_TRC20 | USDT_ERC20 | TON | BTC | ETH (no USDT).
      // CryptoPaymentStatus enum: WAITING | CONFIRMING | CONFIRMED | EXPIRED | FAILED.
      const currency = input.cryptoCurrency ?? 'USDT_TRC20';
      const address = await this.prisma.systemSetting.findUnique({
        where: { key: `payment.crypto.${currency.toLowerCase()}.address` },
      });
      const cryptoPayment = await this.prisma.cryptoPayment.create({
        data: {
          paymentId: payment.id,
          currency,
          address: address?.value ?? '',
          expectedAmount: payment.amount.toString(),
          status: 'WAITING',
          // expiresAt is required on CryptoPayment (no default); allow 24h.
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      // Log for manual/external verification (BullMQ disabled)
      this.logger.log(`Crypto payment created: ${cryptoPayment.id} for ${currency}, will need manual verification`);
      return this.toDto(payment);
    }

    return this.toDto(payment);
  }

  /** Submit a receipt for a card-to-card payment. */
  async submitReceipt(input: {
    userId: bigint;
    paymentPublicId: string;
    payerName: string;
    cardNumber?: string;
    amount?: bigint;
    fileUrl: string;
    fileKey: string;
    mimeType: string;
    fileSize: number;
  }): Promise<ReceiptDto> {
    const payment = await this.getOwnedPayment(input.paymentPublicId, input.userId);
    if (payment.method !== 'CARD_TO_CARD') {
      throw BusinessException.conflict('Receipts only apply to card-to-card payments');
    }
    const receipt = await this.prisma.receipt.create({
      data: {
        publicId: randomUUID(),
        paymentId: payment.id,
        orderId: payment.orderId,
        userId: payment.userId,
        status: 'PENDING',
        payerName: input.payerName,
        cardNumber: input.cardNumber ?? null,
        amount: input.amount ?? null,
        fileUrl: input.fileUrl,
        fileKey: input.fileKey,
        mimeType: input.mimeType,
        fileSize: input.fileSize,
      },
    });
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'AWAITING_VERIFY' },
    });
    return this.toReceiptDto(receipt);
  }

  /**
   * Admin verifies or rejects a receipt (spec #3 + #13).
   *
   * APPROVED → confirm payment, complete order (creates subscription + Sanity
   *   panel user), notify the user that their payment was accepted.
   * REJECTED → mark payment REJECTED, notify the user with the admin's reason.
   *
   * Every decision is audit-logged (APPROVE / REJECT).
   */
  async verifyReceipt(input: {
    adminId: bigint;
    receiptPublicId: string;
    status: 'APPROVED' | 'REJECTED';
    adminNote?: string;
  }): Promise<{ receipt: ReceiptDto; payment: PaymentDto }> {
    const receipt = await this.prisma.receipt.findUnique({
      where: { publicId: input.receiptPublicId },
      include: { payment: { include: { order: true } } },
    });
    if (!receipt) throw BusinessException.notFound('Receipt not found');

    const before = this.toReceiptDto(receipt);
    const updated = await this.prisma.receipt.update({
      where: { id: receipt.id },
      data: {
        status: input.status,
        verifiedById: input.adminId,
        verifiedAt: new Date(),
        rejectionReason: input.status === 'REJECTED' ? (input.adminNote ?? null) : null,
      },
      include: { payment: { include: { order: true } } },
    });

    const userId = receipt.payment.userId;
    const orderRef = receipt.payment.order?.publicId ?? null;

    if (input.status === 'APPROVED') {
      await this.confirmPayment(receipt.paymentId);
      // Audit log — payment approved.
      await this.audit.log({
        userId: input.adminId,
        action: 'APPROVE',
        resource: 'receipts',
        resourceId: receipt.publicId,
        before,
        after: this.toReceiptDto(updated),
        metadata: { paymentId: receipt.paymentId.toString(), orderId: orderRef },
      });
      // Notify the user that their receipt was approved + subscription activated.
      await this.notifyUser(
        userId,
        'PAYMENT_APPROVED',
        'Payment Approved',
        `Your card-to-card receipt has been approved. Your subscription is now active.`,
        { receiptPublicId: receipt.publicId, orderId: orderRef },
      ).catch((e) => this.logger.error(`notify approve failed: ${(e as Error).message}`));
    } else {
      // PaymentStatus has no FAILED; use REJECTED for declined receipts.
      await this.prisma.payment.update({
        where: { id: receipt.paymentId },
        data: { status: 'REJECTED' },
      });
      // Audit log — payment rejected.
      await this.audit.log({
        userId: input.adminId,
        action: 'REJECT',
        resource: 'receipts',
        resourceId: receipt.publicId,
        before,
        after: this.toReceiptDto(updated),
        metadata: {
          paymentId: receipt.paymentId.toString(),
          orderId: orderRef,
          reason: input.adminNote ?? null,
        },
      });
      // Notify the user with the rejection reason.
      await this.notifyUser(
        userId,
        'PAYMENT_REJECTED',
        'Payment Rejected',
        input.adminNote
          ? `Your receipt was rejected. Reason: ${input.adminNote}`
          : `Your receipt was rejected. Please contact support for details.`,
        { receiptPublicId: receipt.publicId, orderId: orderRef, reason: input.adminNote ?? null },
      ).catch((e) => this.logger.error(`notify reject failed: ${(e as Error).message}`));
    }
    return { receipt: this.toReceiptDto(updated), payment: this.toDto(updated.payment) };
  }

  /** Online gateway callback verification. */
  async verifyOnlinePayment(gatewayTransactionId: string, gatewayCode: string): Promise<PaymentDto> {
    const payment = await this.prisma.payment.findFirst({
      where: { gatewayRef: gatewayTransactionId, gateway: gatewayCode },
    });
    if (!payment) throw BusinessException.notFound('Payment not found');
    const gateway = this.gateways.get(gatewayCode);
    if (!gateway) throw BusinessException.conflict('Unknown gateway');

    const result = await gateway.verify({ gatewayTransactionId, paymentId: payment.id });
    if (result.status === 'CONFIRMED') {
      await this.confirmPayment(payment.id);
    } else if (result.status === 'FAILED') {
      // PaymentStatus has no FAILED; map gateway FAILED -> REJECTED.
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'REJECTED' } });
    }
    return this.toDto(await this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }));
  }

  /**
   * Confirm a payment and complete the associated order (spec #12 transaction).
   * Idempotent — safe to call multiple times. Audit-logs the confirmation.
   */
  async confirmPayment(paymentId: bigint): Promise<void> {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: true },
    });
    if (payment.status === 'CONFIRMED') return; // idempotent
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });
    if (payment.orderId) {
      // Plan purchase: complete the order (provisions the subscription).
      await this.orders.completeOrder(payment.orderId, payment.userId);
    } else {
      // Standalone wallet top-up (spec #7): credit the user's wallet.
      await this.wallet.credit(payment.userId, payment.amount, 'DEPOSIT', {
        description: `Wallet top-up (${payment.method})`,
        reference: payment.publicId,
        paymentId: payment.id,
      });
    }
    // Audit log — payment confirmed (order completed OR wallet credited).
    await this.audit.log({
      action: 'ACTIVATE',
      resource: 'payments',
      resourceId: payment.publicId,
      after: {
        status: 'CONFIRMED',
        amount: fromMinor(payment.amount),
        currency: payment.currency,
        orderId: payment.order?.publicId ?? null,
        walletTopUp: !payment.orderId,
      },
    });
  }

  /** Fire-and-forget user notification (never blocks the payment flow). */
  private async notifyUser(
    userId: bigint,
    type: string,
    title: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.notifications.send({
      userId,
      type,
      title,
      body,
      channel: 'TELEGRAM',
      metadata,
    });
  }

  /** Pay an order by redeeming a voucher code. */
  async payWithVoucher(orderPublicId: string, userId: bigint, code: string): Promise<PaymentDto> {
    const order = await this.orders.findOne(orderPublicId, userId);
    if (order.status !== 'PENDING') throw BusinessException.conflict('Order is not payable');

    const voucher = await this.prisma.voucher.findUnique({ where: { code } });
    if (!voucher) throw BusinessException.notFound('Invalid voucher code');
    if (!voucher.isActive) throw BusinessException.conflict('Voucher is not active');
    if (voucher.expiresAt && voucher.expiresAt < new Date()) {
      throw BusinessException.conflict('Voucher expired');
    }
    if (voucher.redeemedById) throw BusinessException.conflict('Voucher already redeemed');
    if (voucher.redemptions >= voucher.maxRedemptions) {
      throw BusinessException.conflict('Voucher redemption limit reached');
    }

    const payment = await this.prisma.payment.create({
      data: {
        publicId: randomUUID(),
        orderId: BigInt(order.id),
        userId,
        method: 'VOUCHER',
        status: 'CONFIRMED',
        amount: BigInt(order.totalAmount.replace(/[^0-9]/g, '')) || 0n,
        currency: order.currency,
        confirmedAt: new Date(),
      },
    });

    await this.prisma.voucher.update({
      where: { id: voucher.id },
      data: {
        isActive: false,
        redeemedById: userId,
        redeemedAt: new Date(),
        redemptions: { increment: 1 },
      },
    });

    await this.orders.completeOrder(BigInt(order.id), userId);
    return this.toDto(payment);
  }

  /** Get a payment by public id (owner-scoped). */
  async findOne(publicId: string, userId: bigint): Promise<PaymentDto> {
    const payment = await this.getOwnedPayment(publicId, userId);
    return this.toDto(payment);
  }

  async listMine(userId: bigint, query: Record<string, unknown>): Promise<PaginatedDto<PaymentDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = { userId };
    const [total, items] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({ where, ...skipTake(params), orderBy: { createdAt: 'desc' } }),
    ]);
    return { data: items.map((p) => this.toDto(p)), meta: buildMeta(total, params) };
  }

  async listReceiptsPending(query: Record<string, unknown>): Promise<PaginatedDto<ReceiptDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    const [total, items] = await Promise.all([
      this.prisma.receipt.count({ where }),
      this.prisma.receipt.findMany({ 
        where, 
        include: { payment: true, user: true },
        ...skipTake(params), 
        orderBy: { createdAt: 'desc' } 
      }),
    ]);
    return { data: items.map((r) => this.toReceiptDto(r)), meta: buildMeta(total, params) };
  }

  private async getOwnedPayment(publicId: string, userId: bigint): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({ where: { publicId } });
    if (!payment) throw BusinessException.notFound('Payment not found');
    if (payment.userId !== userId) throw BusinessException.forbidden('Not your payment');
    return payment;
  }

  private toDto(p: Payment & { metadata?: any }): PaymentDto {
    return {
      id: p.id.toString(),
      publicId: p.publicId,
      orderId: p.orderId?.toString() ?? null,
      method: p.method,
      status: p.status,
      amount: fromMinor(p.amount),
      currency: p.currency,
      gateway: (p as any).gateway ?? null,
      gatewayTransactionId: (p as any).gatewayRef ?? null,
      redirectUrl: p.metadata?.redirectUrl ?? null,
      confirmedAt: p.confirmedAt ?? null,
      createdAt: p.createdAt,
    };
  }

  private toReceiptDto(r: any): ReceiptDto {
    return {
      id: r.id.toString(),
      publicId: r.publicId,
      paymentPublicId: r.payment?.publicId ?? '',
      status: r.status,
      payerName: r.payerName,
      cardNumber: r.cardNumber,
      fileKey: r.fileKey,
      amount: r.amount ? fromMinor(r.amount) : null,
      verifiedBy: r.verifiedById?.toString() ?? null,
      verifiedAt: r.verifiedAt,
      rejectionReason: r.rejectionReason,
      createdAt: r.createdAt,
      // Include user info for admin panel display
      userId: r.userId?.toString() ?? null,
      userName: r.user?.firstName ?? r.user?.username ?? null,
      userTelegramId: r.user?.telegramId ?? null,
    };
  }
}
