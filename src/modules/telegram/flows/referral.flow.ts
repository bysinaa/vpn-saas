import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import { mainMenuKeyboard, referralKeyboard } from '../keyboards';
import { formatDate } from '../format.util';
import { fromMinor } from '@/common/utils/money.util';
import { randomCode } from '@/common/utils/crypto.util';

const HISTORY_PAGE_SIZE = 8;

/**
 * ReferralFlow - "👥 Referral" screen.
 *
 * Shows the user's referral link/code, total + active invited count,
 * commission earned, leaderboard rank, and provides shortcuts to
 * share, view rules, view history and withdraw rewards.
 *
 * Reward rules (commission %, bonus amount) are read from SystemSetting
 * so admins can tune them without a redeploy.
 */
@Injectable()
export class ReferralFlow {
  constructor(
    private readonly runtime: BotRuntime,
    private readonly prisma: PrismaService,
  ) {}

  /** Render the referral dashboard (`referral`). */
  async show(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }

    try {
      // Ensure the user has a referral code (generate lazily).
      let user = await this.prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) {
        await this.runtime.alert(ctx, t(locale, 'error.not.found'));
        return;
      }
      if (!user.referralCode) {
        const code = await this.generateUniqueCode();
        user = await this.prisma.user.update({
          where: { id: session.userId },
          data: { referralCode: code },
        });
      }

      // Total invited + active (referred users with at least one ACTIVE/TRIAL sub).
      const totalInvited = await this.prisma.referralLog.count({
        where: { referrerId: session.userId },
      });
      const activeInvited = await this.prisma.referralLog.count({
        where: {
          referrerId: session.userId,
          status: 'COMPLETED',
        },
      });

      // Commission earned (REFERRAL_REWARD wallet transactions for this user).
      const earningsAgg = await this.prisma.walletTransaction.aggregate({
        where: { wallet: { userId: session.userId }, type: 'REFERRAL_REWARD' },
        _sum: { amount: true },
      });
      const commission = earningsAgg._sum?.amount ?? 0n;

      // Pending rewards (referral logs still PENDING).
      const pendingAgg = await this.prisma.referralLog.aggregate({
        where: { referrerId: session.userId, status: 'PENDING' },
        _sum: { referrerReward: true },
      });
      const pending = pendingAgg._sum?.referrerReward ?? 0n;

      // Leaderboard rank: count referrers with more total referrals.
      const higherCount = await this.prisma.referralLog.groupBy({
        by: ['referrerId'],
        where: { referrerId: { not: session.userId } },
        _count: { _all: true },
      });
      const myCount = totalInvited;
      const rank = higherCount.filter((g) => g._count._all > myCount).length + 1;
      const totalReferrers = higherCount.length + (myCount > 0 ? 1 : 0);

      // Wallet currency for display.
      const wallet = await this.prisma.wallet.findUnique({ where: { userId: session.userId } });
      const currency = wallet?.currency ?? 'IRR';

      const link = this.runtime.buildReferralLink(user.referralCode);
      const shareText = t(locale, 'referral.share.text', { brand: await this.runtime.getBrandName(), link });

      const msg =
        `${t(locale, 'referral.title')}\n\n` +
        `${t(locale, 'referral.link')}: ${link}\n` +
        `${t(locale, 'referral.code', { code: user.referralCode })}\n` +
        `${t(locale, 'referral.totalInvited', { count: totalInvited })}\n` +
        `${t(locale, 'referral.activeInvited', { count: activeInvited })}\n` +
        `${t(locale, 'referral.commission', { amount: fromMinor(commission), currency })}\n` +
        `${t(locale, 'referral.pending', { amount: fromMinor(pending), currency })}\n` +
        `${t(locale, 'referral.leaderboard', { rank, total: totalReferrers })}`;

      await this.runtime.pushMenu(telegramId, 'referral');
      await this.runtime.setState(telegramId, 'idle');
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, msg, referralKeyboard(locale, link, shareText), { parseMode: 'Markdown' });
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Show the reward rules (`refrules`). */
  async showRules(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) return;

    // Read configurable rule values from SystemSetting (with sensible defaults).
    const commissionPct = Number((await this.runtime.getSetting('referral.commission_percent')) ?? '10');
    const bonusMinor = BigInt((await this.runtime.getSetting('referral.signup_bonus_minor')) ?? '0');
    const wallet = await this.prisma.wallet.findUnique({ where: { userId: session.userId } });
    const currency = wallet?.currency ?? 'IRR';

    const referralCode = (await this.prisma.user.findUnique({ where: { id: session.userId } }))?.referralCode ?? '';
    const link = referralCode ? this.runtime.buildReferralLink(referralCode) : '';
    const shareText = t(locale, 'referral.share.text', { brand: await this.runtime.getBrandName(), link });

    const body = t(locale, 'referral.rules.body', {
      commission: commissionPct,
      bonus: fromMinor(bonusMinor),
      currency,
    });

    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, body, referralKeyboard(locale, link, shareText), { parseMode: 'Markdown' });
  }

  /** Show the referral history (`refhistory`), paginated. */
  async showHistory(ctx: Context, page = 0): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }

    try {
      const [total, referrals] = await Promise.all([
        this.prisma.referralLog.count({ where: { referrerId: session.userId } }),
        this.prisma.referralLog.findMany({
          where: { referrerId: session.userId },
          orderBy: { createdAt: 'desc' },
          skip: page * HISTORY_PAGE_SIZE,
          take: HISTORY_PAGE_SIZE,
          include: { referred: { select: { firstName: true, username: true, status: true } } },
        }),
      ]);

      const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
      await this.runtime.alert(ctx);

      if (!referrals.length) {
        await this.runtime.render(ctx, t(locale, 'referral.history.empty'), mainMenuKeyboard(locale), { parseMode: 'Markdown' });
        return;
      }

      const lines = referrals.map((r, idx) => {
        const name = r.referred?.firstName ?? r.referred?.username ?? `#${r.referredId.toString()}`;
        const status = r.status;
        return t(locale, 'referral.history.item', {
          idx: page * HISTORY_PAGE_SIZE + idx + 1,
          name,
          status,
          date: formatDate(r.createdAt, locale),
        });
      });

      const msg = `${t(locale, 'referral.history')}\n\n${lines.join('\n')}`;
      await this.runtime.render(ctx, msg, mainMenuKeyboard(locale), { parseMode: 'Markdown' });
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Generate a unique random referral code (retry on collision). */
  private async generateUniqueCode(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = randomCode(8);
      const exists = await this.prisma.user.findFirst({ where: { referralCode: code }, select: { id: true } });
      if (!exists) return code;
    }
    // Fallback: use a timestamp-suffixed code.
    return `${randomCode(4)}${Date.now().toString(36).slice(-4).toUpperCase()}`;
  }
}
