import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { OrdersService } from '../orders/orders.service';
import { VpnService } from '../vpn/vpn.service';
import { AuditService } from '@/common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { config } from '@/config';
import { hashToken } from '@/common/utils/crypto.util';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import { randomUUID } from 'node:crypto';
import { validate as isUuid } from 'uuid';
import type { CryptoCurrency, Payment, PaymentMethod, Prisma, ReceiptStatus } from '@prisma/client';
import { QUEUES, JOB_NAMES } from '@/common/queue/queue-names';
import { PAYMENT_GATEWAYS, type IPaymentGateway } from './payment-gateway.interface';
import { SettingsService } from '../settings/settings.service';
import { BankCardsService, type BankCardDto } from './bank-cards.service';
import { CryptoWalletsService, type CryptoWalletDto } from './crypto-wallets.service';

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
  cryptoAddress?: string | null;
  cryptoNetwork?: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
}

/**
 * Default online gateway code. Override by registering additional gateways
 * and changing this constant (or sourcing from SystemSetting).
 */
const DEFAULT_ONLINE_GATEWAY_CODE = 'zarinpal';

type GatewayResult = { verificationCode?: number; reference?: string };

interface SettlementResult {
  payment: Payment & { order?: { publicId: string } | null };
  orderResult: { order: any; subscription: any } | null;
  provisioningSubscriptionId: bigint | null;
  settled: boolean;
}

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
 *  - WALLET: settled here atomically with the order
 * Voucher codes are handled only by VouchersService and activate their bound plan directly.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly orders: OrdersService,
    private readonly vpn: VpnService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(PAYMENT_GATEWAYS) private readonly gateways: Map<string, IPaymentGateway>,
    private readonly settings: SettingsService,
    private readonly bankCards: BankCardsService,
    private readonly cryptoWallets: CryptoWalletsService,
  ) {}

  /** Initiate a wallet deposit (not tied to an order). */
  async initiateWalletDeposit(
    userId: bigint,
    amount: string,
    cryptoCurrency?: string,
  ): Promise<PaymentDto> {
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
  }): Promise<PaymentDto> {
    const order = await this.orders.findOne(input.orderPublicId, input.userId);
    if (order.status !== 'PENDING') {
      throw BusinessException.conflict('Order is not payable');
    }

    if (input.method === 'ONLINE' && order.currency !== 'IRT') {
      throw BusinessException.conflict('Online payments require IRT toman orders');
    }
    const onlineGateway =
      input.method === 'ONLINE' ? this.gateways.get(DEFAULT_ONLINE_GATEWAY_CODE) : undefined;
    if (input.method === 'ONLINE' && !onlineGateway) {
      throw BusinessException.conflict(`Gateway '${DEFAULT_ONLINE_GATEWAY_CODE}' not configured`);
    }
    if (onlineGateway?.isEnabled && !(await onlineGateway.isEnabled())) {
      throw BusinessException.conflict('Online gateway is disabled');
    }
    const depositCard: BankCardDto | null =
      input.method === 'CARD_TO_CARD' ? await this.bankCards.getDepositCard() : null;
    if (input.method === 'CARD_TO_CARD' && !depositCard) {
      throw BusinessException.conflict('Card-to-card payment is not configured');
    }
    const cryptoCurrency = input.cryptoCurrency ?? 'USDT_TRC20';
    const cryptoWallet: CryptoWalletDto | null =
      input.method === 'CRYPTO' ? await this.cryptoWallets.getDefault(cryptoCurrency) : null;
    if (input.method === 'CRYPTO' && !cryptoWallet) {
      throw BusinessException.conflict('Crypto payment is not configured');
    }

    const payment = await this.prisma.payment.create({
      data: {
        publicId: randomUUID(),
        orderId: BigInt(order.id),
        userId: input.userId,
        method: input.method,
        status: 'PENDING',
        amount: BigInt(order.totalAmount.replace(/[^0-9]/g, '')) || 0n,
        currency: input.method === 'ONLINE' ? 'IRT' : order.currency,
        metadata:
          input.method === 'CARD_TO_CARD'
            ? { bankCardPublicId: depositCard!.publicId }
            : input.method === 'CRYPTO'
              ? { cryptoWalletPublicId: cryptoWallet!.publicId }
              : undefined,
      },
    });

    if (input.method === 'ONLINE') {
      const gatewayCode = DEFAULT_ONLINE_GATEWAY_CODE;
      const gateway = onlineGateway!;
      const callbackUrl = await this.settings.getValue<string>('gateway.default.callbackUrl', '');
      const result = await gateway.initiate({
        paymentId: payment.id,
        amountToman: payment.amount,
        currency: 'IRT',
        description: `Order ${order.publicId}`,
        callbackUrl:
          callbackUrl.trim() ||
          config.payments.online.callbackUrl ||
          `${config.app.url}/payments/online/callback`,
        userPublicId: order.publicId,
      });
      const requestedPayment = await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          gateway: gateway.code,
          gatewayRef: result.gatewayTransactionId,
          gatewayStatus: 'REQUESTED',
          gatewayResponse: { requestCode: 100 } as any,
          metadata: { redirectUrl: result.redirectUrl } as any,
        },
      });
      return this.toDto(requestedPayment);
    }

    if (input.method === 'CARD_TO_CARD') {
      return this.toDto(payment);
    }

    if (input.method === 'CRYPTO') {
      // CryptoCurrency enum: USDT_TRC20 | USDT_ERC20 | TON | BTC | ETH (no USDT).
      // CryptoPaymentStatus enum: WAITING | CONFIRMING | CONFIRMED | EXPIRED | FAILED.
      const currency = cryptoCurrency;
      const cryptoPayment = await this.prisma.cryptoPayment.create({
        data: {
          paymentId: payment.id,
          currency,
          address: cryptoWallet!.address,
          expectedAmount: payment.amount.toString(),
          status: 'WAITING',
          // expiresAt is required on CryptoPayment (no default); allow 24h.
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      // Log for manual/external verification (BullMQ disabled)
      this.logger.log(
        `Crypto payment created: ${cryptoPayment.id} for ${currency}, will need manual verification`,
      );
      return {
        ...this.toDto(payment),
        cryptoAddress: cryptoWallet!.address,
        cryptoNetwork: cryptoWallet!.network,
      };
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
   * APPROVED → confirm payment, complete order (creates subscription + XUI
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
    const decision = await this.prisma.withTransaction(async (tx) => {
      const receipt = await tx.receipt.findUnique({
        where: { publicId: input.receiptPublicId },
        include: { payment: { include: { order: true } } },
      });
      if (!receipt) throw BusinessException.notFound('Receipt not found');
      if (receipt.status !== 'PENDING') {
        if (receipt.status !== input.status) {
          throw BusinessException.conflict('Receipt already has a different decision');
        }
        const settlement =
          input.status === 'APPROVED'
            ? await this.settlePaymentInTransaction(tx, receipt.paymentId)
            : null;
        return { before: receipt, updated: receipt, applied: false, settlement };
      }

      const claim = await tx.receipt.updateMany({
        where: { id: receipt.id, status: 'PENDING' },
        data: {
          status: input.status,
          verifiedById: input.adminId,
          verifiedAt: new Date(),
          rejectionReason: input.status === 'REJECTED' ? (input.adminNote ?? null) : null,
        },
      });
      if (claim.count !== 1) throw BusinessException.conflict('Receipt decision is in progress');

      let settlement: SettlementResult | null = null;
      if (input.status === 'APPROVED') {
        settlement = await this.settlePaymentInTransaction(tx, receipt.paymentId);
      } else {
        const rejected = await tx.payment.updateMany({
          where: {
            id: receipt.paymentId,
            status: { in: ['INITIATED', 'PENDING', 'AWAITING_VERIFY'] },
          },
          data: { status: 'REJECTED' },
        });
        if (rejected.count !== 1) {
          throw BusinessException.conflict('Payment is no longer rejectable');
        }
      }

      const updated = await tx.receipt.findUniqueOrThrow({
        where: { id: receipt.id },
        include: { payment: { include: { order: true } } },
      });
      return { before: receipt, updated, applied: true, settlement };
    });

    if (decision.settlement) await this.finishSettlement(decision.settlement);
    const receipt = decision.updated;
    const orderRef = receipt.payment.order?.publicId ?? null;

    if (decision.applied) {
      await this.audit.log({
        userId: input.adminId,
        action: input.status === 'APPROVED' ? 'APPROVE' : 'REJECT',
        resource: 'receipts',
        resourceId: receipt.publicId,
        before: this.toReceiptDto(decision.before),
        after: this.toReceiptDto(receipt),
        metadata: {
          paymentId: receipt.paymentId.toString(),
          orderId: orderRef,
          reason: input.status === 'REJECTED' ? (input.adminNote ?? null) : undefined,
        },
      });
      if (input.status === 'REJECTED' || !orderRef) {
        await this.notifyUser(
          receipt.payment.userId,
          input.status === 'APPROVED' ? 'PAYMENT_APPROVED' : 'PAYMENT_REJECTED',
          input.status === 'APPROVED' ? 'Payment Approved' : 'Payment Rejected',
          input.status === 'APPROVED'
            ? 'Your card-to-card receipt has been approved and your wallet was credited.'
            : input.adminNote
              ? `Your receipt was rejected. Reason: ${input.adminNote}`
              : 'Your receipt was rejected. Please contact support for details.',
          { receiptPublicId: receipt.publicId, orderId: orderRef, reason: input.adminNote ?? null },
        ).catch((e) =>
          this.logger.error(`notify receipt decision failed: ${(e as Error).message}`),
        );
      }
    }

    return { receipt: this.toReceiptDto(receipt), payment: this.toDto(receipt.payment) };
  }

  /** Online gateway callback verification. */
  async handleOnlineCallback(authority: string, status: string): Promise<PaymentDto> {
    const payment = await this.prisma.payment.findFirst({
      where: { gatewayRef: authority, gateway: DEFAULT_ONLINE_GATEWAY_CODE },
    });
    if (!payment) throw BusinessException.notFound('Payment not found');
    if (status !== 'OK') {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: { in: ['INITIATED', 'PENDING', 'AWAITING_VERIFY'] } },
        data: { status: 'CANCELLED', gatewayStatus: status },
      });
      return this.toDto(await this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }));
    }
    return this.verifyOnlinePayment(authority, DEFAULT_ONLINE_GATEWAY_CODE);
  }

  async verifyOnlinePayment(
    gatewayTransactionId: string,
    gatewayCode: string,
  ): Promise<PaymentDto> {
    const payment = await this.prisma.payment.findFirst({
      where: { gatewayRef: gatewayTransactionId, gateway: gatewayCode },
    });
    if (!payment) throw BusinessException.notFound('Payment not found');
    const gateway = this.gateways.get(gatewayCode);
    if (!gateway) throw BusinessException.conflict('Unknown gateway');

    const result = await gateway.verify({
      gatewayTransactionId,
      paymentId: payment.id,
      amountToman: payment.amount,
    });
    if (result.status === 'CONFIRMED') {
      await this.confirmPayment(payment.id, result);
    } else if (result.status === 'FAILED') {
      // PaymentStatus has no FAILED; map gateway FAILED -> REJECTED.
      await this.prisma.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: ['INITIATED', 'PENDING', 'AWAITING_VERIFY'] },
        },
        data: { status: 'REJECTED' },
      });
    }
    return this.toDto(await this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }));
  }

  /** Canonical entry point for confirmed gateway, receipt, crypto, and retry settlement. */
  async confirmPayment(paymentId: bigint, gatewayResult?: GatewayResult): Promise<void> {
    const settlement = await this.prisma.withTransaction((tx) =>
      this.settlePaymentInTransaction(tx, paymentId, gatewayResult),
    );
    await this.finishSettlement(settlement);
  }

  /** Canonical wallet-order path: debit, confirm, and complete in one transaction. */
  async payOrderWithWallet(
    orderPublicId: string,
    userId: bigint,
  ): Promise<{ order: any; subscription: any }> {
    if (!isUuid(orderPublicId)) throw BusinessException.notFound('Order not found');
    const settlement = await this.prisma.withTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE "publicId" = ${orderPublicId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({
        where: { publicId: orderPublicId },
        include: { plan: true },
      });
      if (!order) throw BusinessException.notFound('Order not found');
      if (order.userId !== userId) throw BusinessException.forbidden('Not your order');
      if (order.status !== 'PENDING') throw BusinessException.conflict('Order is not payable');

      const payment = await tx.payment.create({
        data: {
          publicId: randomUUID(),
          orderId: order.id,
          userId,
          method: 'WALLET',
          status: 'PENDING',
          amount: order.totalAmount,
          currency: order.currency,
        },
      });
      await this.wallet.mutateBalanceInTransaction(tx, {
        userId,
        type: 'PURCHASE',
        amount: order.totalAmount,
        direction: 'debit',
        description: `Purchase: ${order.plan.name}`,
        reference: order.publicId,
        paymentId: payment.id,
        orderId: order.id,
      });
      return this.settlePaymentInTransaction(tx, payment.id);
    });

    await this.finishSettlement(settlement);
    if (settlement.provisioningSubscriptionId && settlement.orderResult) {
      settlement.orderResult.subscription = await this.prisma.subscription.findUniqueOrThrow({
        where: { id: settlement.provisioningSubscriptionId },
        include: { plan: true, vpnUser: true },
      });
      const subscription = settlement.orderResult.subscription;
      if (!subscription.subscriptionLink && !subscription.vpnUser?.subLink) {
        throw BusinessException.conflict('Subscription provisioning is not complete');
      }
    }
    return settlement.orderResult!;
  }

  private async settlePaymentInTransaction(
    tx: Prisma.TransactionClient,
    paymentId: bigint,
    gatewayResult?: GatewayResult,
  ): Promise<SettlementResult> {
    let payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: true },
    });
    if (payment.status !== 'CONFIRMED') {
      const claim = await tx.payment.updateMany({
        where: { id: paymentId, status: { in: ['INITIATED', 'PENDING', 'AWAITING_VERIFY'] } },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          gatewayStatus: gatewayResult ? 'VERIFIED' : undefined,
          gatewayVerifyCode: gatewayResult?.verificationCode,
          gatewayRefId: gatewayResult?.reference,
          gatewayResponse: gatewayResult
            ? {
                verificationCode: gatewayResult.verificationCode,
                refId: gatewayResult.reference ?? null,
              }
            : undefined,
        },
      });
      if (claim.count !== 1) {
        payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          include: { order: true },
        });
        if (payment.status !== 'CONFIRMED') {
          throw BusinessException.conflict('Payment is not confirmable');
        }
      }
    } else if (gatewayResult) {
      payment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          gatewayStatus: 'VERIFIED',
          gatewayVerifyCode: gatewayResult.verificationCode,
          gatewayRefId: gatewayResult.reference,
        },
        include: { order: true },
      });
    }

    if (payment.orderId) {
      const completed = await this.orders.completeOrderInTransaction(
        tx,
        payment.orderId,
        payment.userId,
      );
      return {
        payment,
        orderResult: { order: completed.order, subscription: completed.subscription },
        provisioningSubscriptionId: completed.subscription
          ? BigInt(completed.subscription.id)
          : null,
        settled: completed.provisioningRequired,
      };
    }

    const existingTopUp = await tx.walletTransaction.findUnique({
      where: { paymentId: payment.id },
    });
    await this.wallet.mutateBalanceInTransaction(tx, {
      userId: payment.userId,
      type: 'DEPOSIT',
      amount: payment.amount,
      direction: 'credit',
      description: `Wallet top-up (${payment.method})`,
      reference: payment.publicId,
      paymentId: payment.id,
    });
    return {
      payment,
      orderResult: null,
      provisioningSubscriptionId: null,
      settled: !existingTopUp,
    };
  }

  private async provisionAfterSettlement(settlement: SettlementResult | null): Promise<void> {
    if (!settlement?.provisioningSubscriptionId) return;
    await this.vpn.createVpnUserForSubscription(settlement.provisioningSubscriptionId);
  }

  private async finishSettlement(settlement: SettlementResult): Promise<void> {
    if (settlement.settled) {
      const payment = settlement.payment;
      await this.audit.log({
        action: 'ACTIVATE',
        resource: 'payments',
        resourceId: payment.publicId,
        after: {
          status: 'CONFIRMED',
          amount: payment.amount.toString(),
          currency: payment.currency,
          orderId: payment.order?.publicId ?? null,
          walletTopUp: !payment.orderId,
        },
      });
    }
    try {
      await this.provisionAfterSettlement(settlement);
    } catch (error) {
      if (settlement.payment.orderId && settlement.payment.method !== 'WALLET') {
        await this.notifySettlement(
          settlement,
          'PROVISIONING_PENDING',
          'Payment confirmed — provisioning pending',
          'Your payment is confirmed, but VPN provisioning is not complete yet. We will retry safely; no second payment is needed.',
        ).catch(() => undefined);
      }
      throw error;
    }

    if (settlement.payment.orderId && settlement.payment.method !== 'WALLET') {
      const subscription = settlement.provisioningSubscriptionId
        ? await this.prisma.subscription.findUnique({
            where: { id: settlement.provisioningSubscriptionId },
            include: { vpnUser: true, plan: true },
          })
        : null;
      const link = subscription?.subscriptionLink ?? subscription?.vpnUser?.subLink ?? null;
      if (!subscription || !link) {
        await this.notifySettlement(
          settlement,
          'PROVISIONING_PENDING',
          'Payment confirmed — provisioning pending',
          'Your payment is confirmed, but the subscription link is not ready yet. We will retry safely; no second payment is needed.',
        );
        throw BusinessException.conflict('Subscription provisioning is not complete');
      }
      await this.notifySettlement(
        settlement,
        'PURCHASE_COMPLETED',
        '✅ پرداخت موفقیت‌آمیز بود',
        `پرداخت شما تأیید شد و اشتراک آماده است.\n\n${subscription.plan.name}\n${link}`,
      );
    }
  }

  private async notifySettlement(
    settlement: SettlementResult,
    event: string,
    title: string,
    body: string,
  ): Promise<void> {
    const orderId = settlement.payment.order?.publicId ?? settlement.payment.orderId?.toString();
    const scopedEvent = `${event}:${orderId}`;
    const sent = await this.prisma.notification.findFirst({
      where: { userId: settlement.payment.userId, event: scopedEvent, status: 'SENT' },
    });
    if (sent) return;
    await this.notifyUser(settlement.payment.userId, scopedEvent, title, body, { orderId });
  }

  /** Persist and deliver a user notification. */
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

  /** Get a payment by public id (owner-scoped). */
  async findOne(publicId: string, userId: bigint): Promise<PaymentDto> {
    const payment = await this.getOwnedPayment(publicId, userId);
    return this.toDto(payment);
  }

  async listMine(
    userId: bigint,
    query: Record<string, unknown>,
  ): Promise<PaginatedDto<PaymentDto>> {
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
        orderBy: { createdAt: 'desc' },
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
      amount: p.amount.toString(),
      currency: p.currency,
      gateway: (p as any).gateway ?? null,
      gatewayTransactionId: null,
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
      amount: r.amount?.toString() ?? null,
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
