import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import { mainMenuKeyboard, profileKeyboard } from '../keyboards';
import { formatDate } from '../format.util';
import { fromMinor } from '@/common/utils/money.util';
import { WalletService } from '../../wallet/wallet.service';

/**
 * ProfileFlow - "👤 Profile" screen.
 *
 * Shows a comprehensive user dashboard:
 *  - name / username / telegram id
 *  - registration date
 *  - referral code
 *  - wallet balance (main + gift)
 *  - total purchases count
 *  - total paid amount (sum of completed order.totalAmount)
 *  - active subscriptions count
 *  - language + role
 *
 * The inline keyboard provides shortcuts to Edit Language, Referral,
 * Wallet and Orders.
 */
@Injectable()
export class ProfileFlow {
  constructor(
    private readonly runtime: BotRuntime,
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  /** Render the profile dashboard (`profile`). */
  async show(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }

    try {
      // Single rich query: user + counts.
      const user = await this.prisma.user.findUnique({
        where: { id: session.userId },
        include: {
          _count: {
            select: {
              subscriptions: true,
              orders: true,
            },
          },
        },
      });
      if (!user) {
        await this.runtime.alert(ctx, t(locale, 'error.not.found'));
        return;
      }

      // Active subscriptions (status ACTIVE or TRIAL).
      const activeSubs = await this.prisma.subscription.count({
        where: {
          userId: session.userId,
          status: { in: ['ACTIVE', 'TRIAL'] },
        },
      });

      // Total paid = sum of completed order totals.
      const paidAgg = await this.prisma.order.aggregate({
        where: { userId: session.userId, status: 'COMPLETED' },
        _sum: { totalAmount: true },
      });

      // Wallet (creates lazily if missing).
      const wallet = await this.wallet.getOrCreateWallet(session.userId);

      const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || '—';
      const roleLabel = user.role === 'ADMIN' ? '👑 ADMIN' : (user.role ?? 'USER');
      const langLabel = locale === 'fa' ? 'فارسی' : 'English';

      const msg =
        `${t(locale, 'profile.title')}\n\n` +
        `${t(locale, 'profile.name')}: ${fullName}\n` +
        `${t(locale, 'profile.username')}: @${user.username || '—'}\n` +
        `${t(locale, 'profile.telegramId')}: ${telegramId}\n` +
        `${t(locale, 'profile.registered')}: ${formatDate(user.createdAt, locale)}\n` +
        `${t(locale, 'profile.referralCode')}: ${user.referralCode ?? '—'}\n` +
        `${t(locale, 'profile.wallet')}: ${fromMinor(wallet.balance)} ${wallet.currency}` +
        (wallet.giftBalance > 0n ? ` (+${fromMinor(wallet.giftBalance)} 🎁)` : '') + '\n' +
        `${t(locale, 'profile.purchases')}: ${user._count.orders}\n` +
        `${t(locale, 'profile.totalPaid')}: ${fromMinor(paidAgg._sum?.totalAmount ?? 0n)} ${wallet.currency}\n` +
        `${t(locale, 'profile.activePlans')}: ${activeSubs}\n` +
        `${t(locale, 'profile.language')}: ${langLabel}\n` +
        `${t(locale, 'profile.role')}: ${roleLabel}`;

      await this.runtime.pushMenu(telegramId, 'profile');
      await this.runtime.setState(telegramId, 'idle');
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, msg, profileKeyboard(locale), { parseMode: 'Markdown' });
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Show the user's recent orders (`profileorders`). */
  async showOrders(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }

    try {
      const orders = await this.prisma.order.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { plan: true },
      });

      await this.runtime.alert(ctx);
      if (!orders.length) {
        await this.runtime.render(
          ctx,
          `${t(locale, 'profile.orders')}\n\n—`,
          profileKeyboard(locale),
          { parseMode: 'Markdown' },
        );
        return;
      }

      const lines = orders.map(
        (o) =>
          `• ${o.plan?.name ?? '—'} — ${fromMinor(o.totalAmount)} ${o.currency} (${o.status}) • ${formatDate(o.createdAt, locale)}`,
      );
      const msg = `${t(locale, 'profile.orders')}\n\n${lines.join('\n')}`;
      await this.runtime.render(ctx, msg, profileKeyboard(locale), { parseMode: 'Markdown' });
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }
}
