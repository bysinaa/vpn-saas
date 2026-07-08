import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { fromMinor, toMinor, type MinorUnits } from '@/common/utils/money.util';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import { randomCode } from '@/common/utils/crypto.util';

export interface AffiliateAccountDto {
  id: string;
  code: string;
  userId: string;
  status: string;
  commissionRate: string;
  totalEarnings: string;
  availableBalance: string;
  withdrawnAmount: string;
  payoutMethod: string | null;
  createdAt: Date;
}

export interface ReferralDto {
  id: string;
  referrerId: string;
  referredId: string;
  status: string;
  referrerReward: string | null;
  referredReward: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

/**
 * AffiliateService - manages the affiliate program (separate from the simpler
 * referral bonus system). Affiliates earn a percentage of referred purchases
 * and can request payouts to their wallet.
 */
@Injectable()
export class AffiliateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  /** Apply for the affiliate program. */
  async apply(userId: bigint): Promise<AffiliateAccountDto> {
    const existing = await this.prisma.affiliateAccount.findUnique({
      where: { userId },
    });
    if (existing) {
      throw BusinessException.conflict('Already an affiliate or application pending');
    }
    const account = await this.prisma.affiliateAccount.create({
      data: {
        userId,
        code: crypto.randomUUID().slice(0, 8),
        status: 'ACTIVE',
        commissionRate: 10,
      },
    });
    return this.toDto(account);
  }

  async getMyAccount(userId: bigint): Promise<AffiliateAccountDto> {
    const account = await this.prisma.affiliateAccount.findUnique({
      where: { userId },
    });
    if (!account) throw BusinessException.notFound('No affiliate account');
    return this.toDto(account);
  }

  async listAccounts(query: Record<string, unknown>): Promise<PaginatedDto<AffiliateAccountDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    const [total, items] = await Promise.all([
      this.prisma.affiliateAccount.count({ where }),
      this.prisma.affiliateAccount.findMany({
        where,
        ...skipTake(params),
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { data: items.map((a) => this.toDto(a)), meta: buildMeta(total, params) };
  }

  async updateAccount(id: bigint, input: {
    status?: string;
    commissionRate?: number;
    payoutMethod?: string;
    payoutDetails?: Record<string, unknown>;
  }): Promise<AffiliateAccountDto> {
    const data: Record<string, unknown> = {};
    if (input.status) data.status = input.status;
    if (input.commissionRate !== undefined) data.commissionRate = input.commissionRate;
    if (input.payoutMethod) data.payoutMethod = input.payoutMethod;
    if (input.payoutDetails) data.payoutDetails = input.payoutDetails;
    const account = await this.prisma.affiliateAccount.update({ where: { id }, data });
    return this.toDto(account);
  }

  /**
   * Process a referral: record the referral log and create a commission
   * entry if the referrer is an active affiliate. Called after order completion.
   */
  async processReferral(input: {
    referrerId: bigint;
    referredId: bigint;
    orderId?: bigint;
    amountMinor: bigint;
    currency: string;
  }): Promise<ReferralDto | null> {
    const affiliate = await this.prisma.affiliateAccount.findUnique({
      where: { userId: input.referrerId },
    });
    const rate = affiliate?.commissionRate ? BigInt(affiliate.commissionRate.toString()) : 0n;
    const commission = affiliate?.status === 'ACTIVE' && rate > 0n
      ? (input.amountMinor * rate) / 100n
      : 0n;

    const referral = await this.prisma.referralLog.create({
      data: {
        referrerId: input.referrerId,
        referredId: input.referredId,
        status: commission > 0n ? 'PENDING' : 'COMPLETED',
        referrerReward: commission,
      },
    });

    if (commission > 0n && affiliate) {
      await this.prisma.affiliateCommission.create({
        data: {
          affiliateId: affiliate.id,
          orderId: input.orderId ?? 0n,
          amount: commission,
          rate: affiliate.commissionRate,
          status: 'PENDING',
        },
      });
      await this.prisma.affiliateAccount.update({
        where: { id: affiliate.id },
        data: {
          totalEarnings: { increment: commission },
          availableBalance: { increment: commission },
        },
      });
    }

    return this.toReferralDto(referral);
  }

  /** Pay out pending commissions to the affiliate's wallet. */
  async payout(userId: bigint, commissionIds: bigint[]): Promise<{ totalPaid: string }> {
    const account = await this.prisma.affiliateAccount.findUnique({
      where: { userId },
    });
    if (!account) throw BusinessException.notFound('No affiliate account');
    if (account.status !== 'ACTIVE') throw BusinessException.conflict('Affiliate not active');

    const commissions = await this.prisma.affiliateCommission.findMany({
      where: { id: { in: commissionIds }, affiliateId: account.id, status: 'PENDING' },
    });
    if (!commissions.length) throw BusinessException.notFound('No pending commissions');

    const total = commissions.reduce((sum, c) => sum + c.amount, 0n);

    await this.prisma.withTransaction(async (tx) => {
      await tx.affiliateCommission.updateMany({
        where: { id: { in: commissionIds } },
        data: { status: 'PAID', paidAt: new Date() },
      });
      await tx.affiliateAccount.update({
        where: { id: account.id },
        data: {
          availableBalance: { decrement: total },
          withdrawnAmount: { increment: total },
        },
      });
    });
    // Credit wallet via wallet service (after the commission tx commits)
    await this.wallet.mutateBalance({
      userId,
      type: 'BONUS',
      amount: total as unknown as MinorUnits,
      direction: 'credit',
      description: 'Affiliate commission payout',
      reference: `affiliate-${account.id}`,
    });
    return { totalPaid: fromMinor(total) };
  }

  async listCommissions(userId: bigint, query: Record<string, unknown>): Promise<any> {
    const params = parsePagination(query);
    const account = await this.prisma.affiliateAccount.findUnique({
      where: { userId },
    });
    if (!account) throw BusinessException.notFound('No affiliate account');
    const where: Record<string, unknown> = { affiliateAccountId: account.id };
    if (query.status) where.status = query.status;
    const [total, items] = await Promise.all([
      this.prisma.affiliateCommission.count({ where }),
      this.prisma.affiliateCommission.findMany({
        where,
        ...skipTake(params),
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      data: items.map((c) => ({
        id: c.id.toString(),
        amount: fromMinor(c.amount),
        currency: 'USD',
        status: c.status,
        paidAt: c.paidAt,
        createdAt: c.createdAt,
      })),
      meta: buildMeta(total, params),
    };
  }

  async listReferrals(query: Record<string, unknown>): Promise<PaginatedDto<ReferralDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.referrerId) where.referrerId = BigInt(query.referrerId as string);
    if (query.status) where.status = query.status;
    const [total, items] = await Promise.all([
      this.prisma.referralLog.count({ where }),
      this.prisma.referralLog.findMany({
        where,
        ...skipTake(params),
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { data: items.map((r) => this.toReferralDto(r)), meta: buildMeta(total, params) };
  }

  private toDto(a: any): AffiliateAccountDto {
    return {
      id: a.id.toString(),
      code: a.code,
      userId: a.userId.toString(),
      status: a.status,
      commissionRate: a.commissionRate?.toString() ?? '0',
      totalEarnings: fromMinor(a.totalEarnings ?? 0n),
      availableBalance: fromMinor(a.availableBalance ?? 0n),
      withdrawnAmount: fromMinor(a.withdrawnAmount ?? 0n),
      payoutMethod: a.payoutMethod ?? null,
      createdAt: a.createdAt,
    };
  }

  private toReferralDto(r: any): ReferralDto {
    return {
      id: r.id.toString(),
      referrerId: r.referrerId.toString(),
      referredId: r.referredId.toString(),
      status: r.status,
      referrerReward: r.referrerReward ? fromMinor(r.referrerReward) : null,
      referredReward: r.referredReward ? fromMinor(r.referredReward) : null,
      completedAt: r.completedAt ?? null,
      createdAt: r.createdAt,
    };
  }
}
