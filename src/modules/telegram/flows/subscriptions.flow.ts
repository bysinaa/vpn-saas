import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import {
  mainMenuKeyboard,
  subscriptionsListKeyboard,
  subscriptionDetailKeyboard,
  paymentMethodKeyboard,
  yesNoKeyboard,
  cancelKeyboard,
} from '../keyboards';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { OrdersService } from '../../orders/orders.service';
import { VpnService } from '../../vpn/vpn.service';
import {
  formatTraffic,
  formatDate,
  daysRemaining,
  progressBar,
  trafficPercent,
  statusEmoji,
} from '../format.util';
import { fromMinor } from '@/common/utils/money.util';

const SUBS_PAGE_SIZE = 5;

/**
 * SubscriptionsFlow - "📡 My Subscriptions" listing + per-subscription detail
 * page with paid renew / extend, reset, link, guide, and report actions.
 *
 * The list is fully dynamic (no hardcoded rows). Each subscription's status
 * determines which actions are available (e.g. reset is only shown when the
 * plan has a traffic quota and usage > 0).
 */
@Injectable()
export class SubscriptionsFlow {
  constructor(
    private readonly runtime: BotRuntime,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly orders: OrdersService,
    private readonly vpn: VpnService,
  ) {}

  // small helper: safely extract telegram id string or null (avoid non-null asserted optional chains)
  private getTelegramId(ctx: Context): string | null {
    return ctx?.from && typeof ctx.from.id !== 'undefined' && ctx.from.id !== null
      ? String(ctx.from.id)
      : null;
  }

  /** Show the paginated list of the user's subscriptions. */
  async showList(ctx: Context, page = 0): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }
    const result = await this.subscriptions.listMine(session.userId, {
      page: page + 1,
      limit: SUBS_PAGE_SIZE,
    });
    await this.runtime.pushMenu(telegramId, 'subs_list');
    await this.runtime.alert(ctx);
    if (!result.data.length) {
      await this.runtime.render(ctx, t(locale, 'subs.empty'), mainMenuKeyboard(locale));
      return;
    }
    const totalPages = Math.max(1, Math.ceil(result.meta.total / SUBS_PAGE_SIZE));
    const kbItems = result.data.map((s) => ({
      publicId: s.publicId,
      label: `${statusEmoji(s.status)} ${s.planName}`,
    }));
    await this.runtime.setState(telegramId, 'subs_viewing_list', { subPage: page });
    await this.runtime.render(
      ctx,
      `${t(locale, 'subs.title')}\n\n${t(locale, 'subs.select')}`,
      subscriptionsListKeyboard(locale, kbItems, page, totalPages),
      { parseMode: 'Markdown' },
    );
  }

  /** Show the detail page for a single subscription (`sub:<publicId>`). */
  async showDetail(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }
    try {
      const sub = await this.prisma.subscription.findUnique({
        where: { publicId: subPublicId },
        include: {
          plan: true,
          vpnUser: true,
          servers: { include: { server: { include: { city: { include: { country: true } } } } } },
        },
      });
      if (!sub || sub.userId !== session.userId) {
        await this.runtime.alert(ctx, t(locale, 'error.not.found'));
        return;
      }

      await this.runtime.setState(telegramId, 'subs_viewing_detail', { subPublicId });
      await this.runtime.pushMenu(telegramId, 'sub_detail');

      // Fetch real-time usage from the 3x-UI panel
      let usedBytes = sub.usedTrafficBytes;
      let limitBytes = sub.trafficLimitBytes;
      let effectiveExpiresAt = sub.expiresAt;
      let effectiveStatus: string = sub.status;

      try {
        const panelUsage = await this.vpn.getUsageFromPanel(sub.id);
        if (panelUsage) {
          usedBytes = panelUsage.usedBytes;
          if (panelUsage.totalBytes !== null) limitBytes = panelUsage.totalBytes;
          if (panelUsage.expiresAt) effectiveExpiresAt = panelUsage.expiresAt;
          if (panelUsage.status) effectiveStatus = panelUsage.status;
        }
      } catch {
        // Fall back to DB data
      }

      const pct = trafficPercent(usedBytes, limitBytes);
      const usage = formatTraffic(usedBytes);
      const traffic = limitBytes ? `${usage} / ${formatTraffic(limitBytes)}` : `${usage} / ∞`;
      const remaining =
        limitBytes === null ? null : limitBytes > usedBytes ? limitBytes - usedBytes : 0n;
      const daysLeft = daysRemaining(effectiveExpiresAt);
      const server = sub.servers[0]?.server;
      const country = server?.city?.country?.name ?? '—';

      const msg =
        `${t(locale, 'sub.detail.title')}\n\n` +
        `${t(locale, 'sub.detail.plan')}: ${sub.plan.name}\n` +
        `${t(locale, 'sub.detail.status')}: ${statusEmoji(effectiveStatus)} ${effectiveStatus}\n` +
        `${t(locale, 'sub.detail.server')}: ${server?.name ?? '—'}\n` +
        `${t(locale, 'sub.detail.country')}: ${country}\n` +
        `${t(locale, 'sub.detail.traffic')}: ${traffic}` +
        (remaining !== null
          ? `\n${t(locale, 'sub.detail.remaining')}: ${formatTraffic(remaining)}`
          : '') +
        (pct !== null ? `\n${progressBar(pct)} ${pct}%` : '') +
        '\n' +
        `${t(locale, 'sub.detail.expires')}: ${effectiveExpiresAt ? formatDate(effectiveExpiresAt, locale) : '∞'}` +
        (daysLeft !== null ? ` (${t(locale, 'sub.detail.daysLeft', { days: daysLeft })})` : '') +
        '\n' +
        `${t(locale, 'sub.detail.created')}: ${formatDate(sub.createdAt, locale)}`;

      const canReset = !!limitBytes && usedBytes > 0n && sub.status !== 'EXPIRED';
      await this.runtime.alert(ctx);
      await this.runtime.render(
        ctx,
        msg,
        subscriptionDetailKeyboard(locale, subPublicId, { canReset }),
        { parseMode: 'Markdown' },
      );
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(
        ctx,
        this.runtime.translateError(locale, err),
        mainMenuKeyboard(locale),
      );
    }
  }

  /** Show the subscription link (re-renders detail with the link highlighted). */
  async showLink(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) return;
    const sub = await this.prisma.subscription.findUnique({
      where: { publicId: subPublicId },
      include: { vpnUser: true },
    });
    if (!sub || sub.userId !== session.userId) {
      await this.runtime.alert(ctx, t(locale, 'error.not.found'));
      return;
    }
    const link = sub.subscriptionLink ?? sub.vpnUser?.subLink ?? null;
    if (!link) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, t(locale, 'error.xui'), mainMenuKeyboard(locale));
      return;
    }
    await this.runtime.alert(ctx);
    await this.runtime.render(
      ctx,
      `${t(locale, 'sub.link.title')}\n\n\`${link}\``,
      mainMenuKeyboard(locale),
      { parseMode: 'Markdown' },
    );
  }

  /** Show the connection guide. */
  async showGuide(ctx: Context, _subPublicId: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.alert(ctx);
    await this.runtime.render(
      ctx,
      `${t(locale, 'sub.guide.title')}\n\n${t(locale, 'sub.guide.body')}`,
      mainMenuKeyboard(locale),
      { parseMode: 'Markdown' },
    );
  }

  /** Confirm a renew action (`subrenew:<id>` -> yes/no). */
  async confirmRenew(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) return;
    const sub = await this.prisma.subscription.findUnique({
      where: { publicId: subPublicId },
      include: { plan: true },
    });
    if (!sub || sub.userId !== session.userId) {
      await this.runtime.alert(ctx, t(locale, 'error.not.found'));
      return;
    }
    await this.runtime.alert(ctx);
    await this.runtime.render(
      ctx,
      t(locale, 'sub.renew.confirm', {
        amount: fromMinor(sub.plan.price),
        currency: sub.plan.currency,
      }),
      yesNoKeyboard(locale, 'renew', subPublicId),
    );
  }

  /** Execute a confirmed renew. */
  async doRenew(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const result = await this.runtime.withLock(telegramId, async () => {
      const locale = await this.runtime.getLocale(telegramId);
      const session = await this.runtime.getSession(telegramId);
      if (!session.userId) return;
      try {
        await this.createRenewalOrder(ctx, subPublicId, 'RENEW');
      } catch (err: any) {
        await this.runtime.alert(ctx);
        await this.runtime.render(
          ctx,
          this.runtime.translateError(locale, err),
          mainMenuKeyboard(locale),
        );
      }
    });
    if (result === undefined)
      await this.runtime.alert(ctx, t(await this.runtime.getLocale(telegramId), 'common.loading'));
  }

  /** Create a paid extension order using the current plan offer. */
  async promptExtend(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const result = await this.runtime.withLock(telegramId, () =>
      this.createRenewalOrder(ctx, subPublicId, 'EXTEND'),
    );
    if (result === undefined) {
      await this.runtime.alert(ctx, t(await this.runtime.getLocale(telegramId), 'common.loading'));
    }
  }

  private async createRenewalOrder(
    ctx: Context,
    subPublicId: string,
    type: 'RENEW' | 'EXTEND',
  ): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) return;
    try {
      const sub = await this.prisma.subscription.findUnique({
        where: { publicId: subPublicId },
        include: { plan: true },
      });
      if (!sub || sub.userId !== session.userId) {
        await this.runtime.alert(ctx, t(locale, 'error.not.found'));
        return;
      }
      const order = await this.orders.create({
        userId: session.userId,
        planPublicId: sub.plan.publicId,
        type,
        targetSubscriptionPublicId: subPublicId,
      });
      await this.runtime.setState(telegramId, 'buy_awaiting_payment', {
        orderId: order.publicId,
      });
      await this.runtime.alert(ctx);
      await this.runtime.render(
        ctx,
        `${t(locale, 'confirm.created')}\n\n${t(locale, 'confirm.total', {
          amount: order.totalAmount,
          currency: order.currency,
        })}`,
        paymentMethodKeyboard(locale),
      );
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(
        ctx,
        this.runtime.translateError(locale, err),
        mainMenuKeyboard(locale),
      );
    }
  }

  /** Confirm a traffic reset (`subreset:<id>` -> yes/no). */
  async confirmReset(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.alert(ctx);
    await this.runtime.render(
      ctx,
      t(locale, 'sub.reset.confirm'),
      yesNoKeyboard(locale, 'reset', subPublicId),
    );
  }

  /** Execute a confirmed traffic reset. */
  async doReset(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const result = await this.runtime.withLock(telegramId, async () => {
      const locale = await this.runtime.getLocale(telegramId);
      const session = await this.runtime.getSession(telegramId);
      if (!session.userId) return;
      try {
        await this.subscriptions.resetTraffic(subPublicId, session.userId);
        await this.runtime.alert(ctx);
        await this.runtime.render(ctx, t(locale, 'sub.reset.success'), mainMenuKeyboard(locale));
      } catch (err: any) {
        await this.runtime.alert(ctx);
        await this.runtime.render(
          ctx,
          this.runtime.translateError(locale, err),
          mainMenuKeyboard(locale),
        );
      }
    });
    if (result === undefined)
      await this.runtime.alert(ctx, t(await this.runtime.getLocale(telegramId), 'common.loading'));
  }

  /** Open a support ticket pre-filled with the subscription context. */
  async reportProblem(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.setState(telegramId, 'support_awaiting_subject', {
      ticketCategory: 'TECHNICAL',
      reportSubId: subPublicId,
    });
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'support.subject.prompt'), cancelKeyboard(locale));
  }
}
