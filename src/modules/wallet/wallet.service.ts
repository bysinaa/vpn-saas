import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { addMoney, subMoney, fromMinor, type MinorUnits } from '@/common/utils/money.util';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import type { Prisma, WalletTxnType, WalletTxnStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export interface WalletDto {
  id: string;
  balance: string;
  giftBalance: string;
  totalDeposited: string;
  totalSpent: string;
  currency: string;
}

export interface WalletTxnDto {
  id: string;
  publicId: string;
  type: WalletTxnType;
  status: WalletTxnStatus;
  amount: string;
  fee: string;
  balanceBefore: string;
  balanceAfter: string;
  description: string | null;
  reference: string | null;
  createdAt: Date;
}

export interface WalletMutation {
  userId: bigint;
  type: WalletTxnType;
  amount: MinorUnits;
  direction: 'credit' | 'debit';
  description?: string;
  reference?: string;
  paymentId?: bigint;
  orderId?: bigint;
  metadata?: unknown;
  status?: WalletTxnStatus;
  useGiftBalance?: boolean;
}

/**
 * WalletService - the single source of truth for money movement.
 * All mutations go through `mutateBalance` which is fully transactional and
 * records the before/after balances, preventing race conditions.
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateWallet(userId: bigint) {
    return this.prisma.wallet.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  async getBalance(userId: bigint): Promise<WalletDto> {
    const wallet = await this.getOrCreateWallet(userId);
    return this.toDto(wallet);
  }

  async listTransactions(
    userId: bigint,
    query: Record<string, unknown>,
  ): Promise<PaginatedDto<WalletTxnDto>> {
    const params = parsePagination(query);
    const wallet = await this.getOrCreateWallet(userId);
    const where: Record<string, unknown> = { walletId: wallet.id };
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    const [total, items] = await Promise.all([
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.findMany({
        where,
        ...skipTake(params),
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { data: items.map(this.toTxnDto), meta: buildMeta(total, params) };
  }

  /**
   * Core atomic balance mutation. Records a transaction row and updates the
   * wallet balance within a DB transaction. Use negative `amount` to debit.
   */
  async mutateBalance(params: WalletMutation): Promise<WalletTxnDto> {
    return this.prisma.withTransaction((tx) => this.mutateBalanceInTransaction(tx, params));
  }

  async mutateBalanceInTransaction(
    tx: Prisma.TransactionClient,
    params: WalletMutation,
  ): Promise<WalletTxnDto> {
    const { userId, type, amount, direction } = params;
    const wallet = await tx.wallet.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });

    // Serializes all mutations for this wallet, including duplicate callbacks.
    const locked = await tx.$queryRaw<
      { balance: bigint; giftBalance: bigint; totalDeposited: bigint; totalSpent: bigint }[]
    >`
      SELECT balance, "giftBalance", "totalDeposited", "totalSpent"
      FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `;
    const currentBalance = locked[0]?.balance ?? wallet.balance;
    const currentGift = locked[0]?.giftBalance ?? wallet.giftBalance;
    const currentDeposited = locked[0]?.totalDeposited ?? wallet.totalDeposited;
    const currentSpent = locked[0]?.totalSpent ?? wallet.totalSpent;

    if (params.paymentId) {
      const existing = await tx.walletTransaction.findUnique({
        where: { paymentId: params.paymentId },
      });
      if (existing) return this.toTxnDto(existing);
    }

    let balanceBefore: MinorUnits;
    let newMainBalance = currentBalance;
    let newGiftBalance = currentGift;

    if (direction === 'credit') {
      balanceBefore = params.useGiftBalance ? currentGift : currentBalance;
      if (params.useGiftBalance) {
        newGiftBalance = addMoney(currentGift, amount);
      } else {
        newMainBalance = addMoney(currentBalance, amount);
      }
    } else {
      balanceBefore = params.useGiftBalance ? currentGift : currentBalance;
      if (params.useGiftBalance) {
        if (currentGift < amount) throw this.insufficient();
        newGiftBalance = subMoney(currentGift, amount);
      } else {
        if (currentBalance < amount) throw this.insufficient();
        newMainBalance = subMoney(currentBalance, amount);
      }
    }
    const balanceAfter: MinorUnits = params.useGiftBalance ? newGiftBalance : newMainBalance;

    const txn = await tx.walletTransaction.create({
      data: {
        publicId: randomUUID(),
        walletId: wallet.id,
        type,
        status: params.status ?? 'CONFIRMED',
        amount,
        fee: 0n,
        balanceBefore,
        balanceAfter,
        description: params.description ?? null,
        reference: params.reference ?? null,
        paymentId: params.paymentId ?? null,
        orderId: params.orderId ?? null,
        metadata: (params.metadata as object) ?? undefined,
      },
    });

    await tx.wallet.update({
      where: { userId },
      data: {
        balance: newMainBalance,
        giftBalance: newGiftBalance,
        totalDeposited:
          direction === 'credit' &&
          !params.useGiftBalance &&
          (type === 'DEPOSIT' || type === 'BONUS' || type === 'CASHBACK')
            ? addMoney(currentDeposited, amount)
            : currentDeposited,
        totalSpent:
          direction === 'debit' && type === 'PURCHASE'
            ? addMoney(currentSpent, amount)
            : currentSpent,
      },
    });

    return this.toTxnDto(txn);
  }

  /** Convenience: credit funds into wallet. */
  credit(
    userId: bigint,
    amount: MinorUnits,
    type: WalletTxnType,
    opts: {
      description?: string;
      reference?: string;
      useGiftBalance?: boolean;
      paymentId?: bigint;
    } = {},
  ) {
    return this.mutateBalance({ userId, type, amount, direction: 'credit', ...opts });
  }

  /** Convenience: debit funds from wallet (throws if insufficient). */
  debit(
    userId: bigint,
    amount: MinorUnits,
    type: WalletTxnType,
    opts: {
      description?: string;
      reference?: string;
      useGiftBalance?: boolean;
      orderId?: bigint;
    } = {},
  ) {
    return this.mutateBalance({ userId, type, amount, direction: 'debit', ...opts });
  }

  /** Reverse a previous transaction (for refunds). */
  async reverse(transactionId: string, reason?: string): Promise<WalletTxnDto> {
    const original = await this.prisma.walletTransaction.findUnique({
      where: { publicId: transactionId },
      include: { wallet: true },
    });
    if (!original) throw BusinessException.notFound('Transaction not found');
    if (original.status === 'REVERSED') throw BusinessException.conflict('Already reversed');

    const reversal = await this.mutateBalance({
      userId: original.wallet.userId,
      type: 'REFUND',
      amount: original.amount,
      direction: original.type === 'PURCHASE' || original.type === 'WITHDRAW' ? 'credit' : 'debit',
      description: reason ?? `Reversal of ${transactionId}`,
      reference: transactionId,
    });

    await this.prisma.walletTransaction.update({
      where: { id: original.id },
      data: { status: 'REVERSED' },
    });

    return reversal;
  }

  private insufficient() {
    return new BusinessException(
      'WALLET_INSUFFICIENT_FUNDS',
      'Insufficient wallet balance',
      undefined as never,
    );
  }

  private toDto(w: any): WalletDto {
    return {
      id: w.id.toString(),
      balance: fromMinor(w.balance),
      giftBalance: fromMinor(w.giftBalance),
      totalDeposited: fromMinor(w.totalDeposited),
      totalSpent: fromMinor(w.totalSpent),
      currency: w.currency,
    };
  }

  private toTxnDto = (t: any): WalletTxnDto => ({
    id: t.id.toString(),
    publicId: t.publicId,
    type: t.type,
    status: t.status,
    amount: fromMinor(t.amount),
    fee: fromMinor(t.fee),
    balanceBefore: fromMinor(t.balanceBefore),
    balanceAfter: fromMinor(t.balanceAfter),
    description: t.description ?? null,
    reference: t.reference ?? null,
    createdAt: t.createdAt,
  });
}
