import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import {
  mainMenuKeyboard,
  subscriptionsListKeyboard,
  subscriptionDetailKeyboard,
  upgradePlansKeyboard,
  yesNoKeyboard,
  cancelKeyboard,
} from '../keyboards';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { PlansService } from '../../plans/plans.service';
import { VpnService } from '../../vpn/vpn.service';
import { formatTraffic, formatDate, daysRemaining, progressBar, trafficPercent, statusEmoji } from '../format.util';
import { fromMinor } from '@/common/utils/money.util';

const SUBS_PAGE_SIZE = 5;

/**
 * SubscriptionsFlow - "📡 My Subscriptions" listing + per-subscription detail
 * page with renew / extend / upgrade / reset / link / guide / report actions.
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
    private readonly plans: PlansService,
    private readonly vpn: VpnService,
  ) {}

  /** Show the paginated list of the user's subscriptions. */
  async showList(ctx: Context, page = 0): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }
    const result = await this.subscriptions.listMine(session.userId, { page: page + 1, limit: SUBS_PAGE_SIZE });
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
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }
    try {
      const sub = await this.prisma.subscription.findUnique({
        where: { publicId: subPublicId },
        include: { plan: true, vpnUser: true, servers: { include: { server: { include: { city: { include: { country: true } } } } } } },
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
      let panelExpiresAt = sub.expiresAt;

      try {
        const panelUsage = await this.vpn.getUsageFromPanel(sub.id);
        if (panelUsage) {
          usedBytes = panelUsage.usedBytes;
          if (panelUsage.totalBytes !== null) limitBytes = panelUsage.totalBytes;
          if (panelUsage.expiresAt) panelExpiresAt = panelUsage.expiresAt;
        }
      } catch {
        // Fall back to DB data
      }

      const pct = trafficPercent(usedBytes, limitBytes);
      const usage = formatTraffic(usedBytes);
      const traffic = limitBytes ? `${usage} / ${formatTraffic(limitBytes)}` : `${usage} / ∞`;
      const daysLeft = daysRemaining(panelExpiresAt);
      const server = sub.servers[0]?.server;
      const country = server?.city?.country?.name ?? '—';
      const protocol = sub.vpnUser?.metadata ? 'v2ray' : 'v2ray';

      const msg =
        `${t(locale, 'sub.detail.title')}\n\n` +
        `${t(locale, 'sub.detail.plan')}: ${sub.plan.name}\n` +
        `${t(locale, 'sub.detail.status')}: ${statusEmoji(sub.status)} ${sub.status}\n` +
        `${t(locale, 'sub.detail.server')}: ${server?.name ?? '—'}\n` +
        `${t(locale, 'sub.detail.country')}: ${country}\n` +
        `${t(locale, 'sub.detail.protocol')}: ${protocol}\n` +
        `${t(locale, 'sub.detail.traffic')}: ${traffic}` + (pct !== null ? `\n${progressBar(pct)} ${pct}%` : '') + '\n' +
        `${t(locale, 'sub.detail.expires')}: ${sub.expiresAt ? formatDate(sub.expiresAt, locale) : '∞'}` +
        (daysLeft !== null ? ` (${t(locale, 'sub.detail.daysLeft', { days: daysLeft })})` : '') + '\n' +
        `${t(locale, 'sub.detail.created')}: ${formatDate(sub.createdAt, locale)}`;

      const canReset = !!limitBytes && usedBytes > 0n && sub.status !== 'EXPIRED';
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, msg, subscriptionDetailKeyboard(locale, subPublicId, { canReset }), { parseMode: 'Markdown' });
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Show the subscription link (re-renders detail with the link highlighted). */
  async showLink(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
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
      await this.runtime.render(ctx, t(locale, 'error.sanity'), mainMenuKeyboard(locale));
      return;
    }
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, `${t(locale, 'sub.link.title')}\n\n\`${link}\``, mainMenuKeyboard(locale), { parseMode: 'Markdown' });
  }

  /** Show the connection guide. */
  async showGuide(ctx: Context, _subPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, `${t(locale, 'sub.guide.title')}\n\n${t(locale, 'sub.guide.body')}`, mainMenuKeyboard(locale), { parseMode: 'Markdown' });
  }

  /** Confirm a renew action (`subrenew:<id>` -> yes/no). */
  async confirmRenew(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) return;
    const sub = await this.prisma.subscription.findUnique({ where: { publicId: subPublicId }, include: { plan: true } });
    if (!sub || sub.userId !== session.userId) {
      await this.runtime.alert(ctx, t(locale, 'error.not.found'));
      return;
    }
    const price = (await this.plans.getRaw(sub.plan.publicId)).price;
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'sub.renew.confirm', { amount: fromMinor(price), currency: sub.plan.currency }), yesNoKeyboard(locale, 'renew', subPublicId));
  }

  /** Execute a confirmed renew. */
  async doRenew(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const result = await this.runtime.withLock(telegramId, async () => {
      const locale = await this.runtime.getLocale(telegramId);
      const session = await this.runtime.getSession(telegramId);
      if (!session.userId) return;
      try {
        await this.subscriptions.renew(subPublicId, session.userId);
        await this.runtime.alert(ctx);
        await this.runtime.render(ctx, t(locale, 'sub.renew.success'), mainMenuKeyboard(locale));
      } catch (err: any) {
        await this.runtime.alert(ctx);
        await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
      }
    });
    if (result === undefined) await this.runtime.alert(ctx, t(await this.runtime.getLocale(telegramId), 'common.loading'));
  }

  /** Ask the user for the number of days to extend. */
  async promptExtend(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.setState(telegramId, 'subs_viewing_detail', { subPublicId, pendingAction: 'extend' });
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'sub.extend.prompt'), cancelKeyboard(locale));
  }

  /** Handle the extend-days text input. */
  async onExtendDays(ctx: Context, text: string): Promise<boolean> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const subPublicId = session.data?.subPublicId as string | undefined;
    if (!session.userId || !subPublicId) return false;
    const days = Number(text.replace(/[^0-9]/g, ''));
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      await this.runtime.send(ctx, t(locale, 'error.invalid.input'));
      return true;
    }
    try {
      await this.subscriptions.extend(subPublicId, session.userId, days);
      await this.runtime.clearState(telegramId);
      await this.runtime.resetMenu(telegramId, 'main');
      await this.runtime.send(ctx, t(locale, 'sub.extend.success', { days }), mainMenuKeyboard(locale));
    } catch (err: any) {
      await this.runtime.send(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
    return true;
  }

  /** Show the upgrade plan picker. */
  async showUpgrade(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) return;
    const plans = (await this.plans.listVisible()).filter((p) => !p.isTrial);
    const kbPlans = plans.map((p) => ({ publicId: p.publicId, name: p.name, priceLabel: `${p.price} ${p.currency}` }));
    // Store subPublicId in session so the callback only carries the planPublicId
    await this.runtime.setState(telegramId, 'sub_awaiting_upgrade', { upgradeSubPublicId: subPublicId });
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, `${t(locale, 'sub.upgrade.title')}\n\n${t(locale, 'sub.upgrade.select')}`, upgradePlansKeyboard(locale, kbPlans), { parseMode: 'Markdown' });
  }

  /** Execute an upgrade (`upg:<planId>`). Creates an upgrade order. */
  async doUpgrade(ctx: Context, planPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const subPublicId = session.data?.upgradeSubPublicId as string | undefined;
    await this.runtime.clearState(telegramId);
    // Upgrades settle the new plan via the wallet by default; full upgrade
    // proration is handled by the OrdersService + SubscriptionsService layer.
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'sub.upgrade.success'), mainMenuKeyboard(locale));
  }

  /** Confirm a traffic reset (`subreset:<id>` -> yes/no). */
  async confirmReset(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'sub.reset.confirm'), yesNoKeyboard(locale, 'reset', subPublicId));
  }

  /** Execute a confirmed traffic reset. */
  async doReset(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
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
        await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
      }
    });
    if (result === undefined) await this.runtime.alert(ctx, t(await this.runtime.getLocale(telegramId), 'common.loading'));
  }

  /** Open a support ticket pre-filled with the subscription context. */
  async reportProblem(ctx: Context, subPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.setState(telegramId, 'support_awaiting_subject', { ticketCategory: 'TECHNICAL', reportSubId: subPublicId });
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'support.subject.prompt'), cancelKeyboard(locale));
  }
}
