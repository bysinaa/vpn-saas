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
import { VpnService } from '../vpn/vpn.service';

export interface ReferralTrafficRewardResult {
  referrerTelegramId: string | null;
  referrerName: string;
  referredTelegramId: string | null;
  referredName: string;
  rewardBytes: string;
  referrerSubscriptionLink: string | null;
  referredSubscriptionLink: string | null;
}

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
    private readonly vpn: VpnService,
  ) {}

  /**
   * Apply a Telegram signup reward exactly once, then synchronize the same
   * per-user trial client in XUI. COMPLETED means the database quota is safely
   * committed but remote provisioning still needs a retry.
   */
  async fulfillTelegramSignupReferral(
    referredUserId: bigint,
    retryOnConflict = true,
  ): Promise<ReferralTrafficRewardResult | null> {
    const referral = await this.prisma.referralLog.findFirst({
      where: { referredId: referredUserId, rewardType: 'TRAFFIC' },
      include: {
        referrer: { select: { telegramId: true, firstName: true, username: true } },
        referred: { select: { telegramId: true, firstName: true, username: true } },
      },
    });
    if (!referral || referral.status === 'REWARDED' || referral.status === 'CANCELLED') return null;

    const rewardBytes = referral.referrerReward;
    if (rewardBytes <= 0n || referral.referredReward !== rewardBytes) {
      throw BusinessException.conflict('Invalid referral traffic reward');
    }

    let subscriptionIds: bigint[] = [];
    if (referral.status === 'PENDING') {
      const plan = await this.prisma.plan.findFirst({
        where: { isTrial: true, isEnabled: true, status: { not: 'ARCHIVED' } },
        orderBy: { createdAt: 'asc' },
      });
      if (!plan) throw BusinessException.conflict('Free Trial plan is not available');

      try {
        subscriptionIds = await this.prisma.withTransaction(async (tx) => {
          const claimed = await tx.referralLog.updateMany({
            where: { id: referral.id, status: 'PENDING' },
            data: { status: 'COMPLETED', completedAt: new Date() },
          });
          if (!claimed.count) return [];

          const now = new Date();
          const rewardExpiry = plan.durationDays
            ? new Date(now.getTime() + plan.durationDays * 86_400_000)
            : null;
          const ids: bigint[] = [];
          for (const userId of [referral.referrerId, referral.referredId]) {
            const existing = await tx.subscription.findFirst({
              where: { userId, isTrial: true },
              orderBy: { createdAt: 'asc' },
            });
            if (existing) {
              const updated = await tx.subscription.update({
                where: { id: existing.id },
                data: {
                  trafficLimitBytes:
                    existing.trafficLimitBytes == null
                      ? rewardBytes
                      : { increment: rewardBytes },
                  status: 'TRIAL',
                  expiresAt:
                    existing.expiresAt && existing.expiresAt > now
                      ? existing.expiresAt
                      : rewardExpiry,
                },
              });
              ids.push(updated.id);
            } else {
              const created = await tx.subscription.create({
                data: {
                  userId,
                  planId: plan.id,
                  status: 'TRIAL',
                  type: plan.type,
                  trafficLimitBytes: rewardBytes,
                  durationDays: plan.durationDays,
                  startsAt: now,
                  expiresAt: rewardExpiry,
                  deviceLimit: plan.deviceLimit,
                  isTrial: true,
                  metadata: { source: 'telegram_referral' },
                },
              });
              await tx.subscriptionEvent.create({
                data: {
                  subscriptionId: created.id,
                  event: 'CREATED',
                  payload: { source: 'telegram_referral', referralId: referral.id.toString() },
                },
              });
              ids.push(created.id);
            }
          }
          return ids;
        });
      } catch (error: any) {
        if (retryOnConflict && ['P2002', 'P2034'].includes(error?.code)) {
          return this.fulfillTelegramSignupReferral(referredUserId, false);
        }
        throw error;
      }
    }

    if (!subscriptionIds.length) {
      const subscriptions = await this.prisma.subscription.findMany({
        where: {
          userId: { in: [referral.referrerId, referral.referredId] },
          isTrial: true,
        },
        orderBy: { createdAt: 'asc' },
      });
      subscriptionIds = [referral.referrerId, referral.referredId]
        .map((userId) => subscriptions.find((subscription) => subscription.userId === userId)?.id)
        .filter((id): id is bigint => id != null);
    }
    if (subscriptionIds.length !== 2) {
      throw BusinessException.conflict('Referral trial subscription is incomplete');
    }

    for (const subscriptionId of subscriptionIds) {
      await this.vpn.createVpnUserForSubscription(subscriptionId);
    }
    await this.prisma.referralLog.updateMany({
      where: { id: referral.id, status: 'COMPLETED' },
      data: { status: 'REWARDED' },
    });

    const subscriptions = await this.prisma.subscription.findMany({
      where: { id: { in: subscriptionIds } },
      select: { userId: true, subscriptionLink: true },
    });
    const linkFor = (userId: bigint) =>
      subscriptions.find((subscription) => subscription.userId === userId)?.subscriptionLink ??
      null;
    return {
      referrerTelegramId: referral.referrer.telegramId,
      referrerName: referral.referrer.firstName ?? referral.referrer.username ?? 'کاربر جدید',
      referredTelegramId: referral.referred.telegramId,
      referredName: referral.referred.firstName ?? referral.referred.username ?? 'کاربر جدید',
      rewardBytes: rewardBytes.toString(),
      referrerSubscriptionLink: linkFor(referral.referrerId),
      referredSubscriptionLink: linkFor(referral.referredId),
    };
  }

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

  async updateAccount(
    id: bigint,
    input: {
      status?: string;
      commissionRate?: number;
      payoutMethod?: string;
      payoutDetails?: Record<string, unknown>;
    },
  ): Promise<AffiliateAccountDto> {
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
    const commission =
      affiliate?.status === 'ACTIVE' && rate > 0n ? (input.amountMinor * rate) / 100n : 0n;

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
