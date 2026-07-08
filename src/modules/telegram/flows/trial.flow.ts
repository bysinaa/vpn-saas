import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AuditService } from '@/common/audit/audit.service';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import { mainMenuKeyboard } from '../keyboards';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { formatTraffic, formatDate } from '../format.util';

/**
 * TrialFlow (spec #1) — provisions a free trial subscription after running
 * the full eligibility gauntlet. Every threshold is read from SystemSettings
 * (admin-configurable) so nothing is hardcoded:
 *
 *   - trial.enabled            → master switch
 *   - trial.trafficLimitGb     → 500MB by default (0.5)
 *   - trial.durationDays       → trial duration (3 days by default)
 *   - trial.perAccountLimit    → one trial per account (1)
 *   - trial.dailyGlobalLimit   → global daily cap (50)
 *
 * Flow:
 *   1. Is the trial feature enabled?              -> disabled
 *   2. Has the user already used a trial?          -> TRIAL_ALREADY_USED
 *   3. Is there an ENABLED trial plan configured? -> (none) disabled
 *   4. Is at least one server ONLINE?             -> no server available
 *   5. Daily trial creation limit reached?         -> TOO_MANY_REQUESTS
 *
 * Only when all checks pass do we provision. The VPN user is created in the
 * background by VpnService (enqueued, retried on failure). The activation is
 * audit-logged (ACTIVATE) and the user sees the connection guide immediately.
 */
@Injectable()
export class TrialFlow {
  constructor(
    private readonly runtime: BotRuntime,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly audit: AuditService,
  ) {}

  /** Entry point: run eligibility checks and provision a trial. */
  async start(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const result = await this.runtime.withLock(telegramId, () => this.provisionTrial(ctx));
    if (result === undefined) {
      await this.runtime.alert(ctx, t(await this.runtime.getLocale(telegramId), 'common.loading'));
    }
  }

  private async provisionTrial(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }
    await this.runtime.alert(ctx);

    // 0. Master switch — admin can disable trials entirely.
    const trialEnabled = (await this.runtime.getSetting('trial.enabled')) !== 'false';
    if (!trialEnabled) {
      await this.runtime.send(ctx, t(locale, 'trial.disabled'), mainMenuKeyboard(locale));
      return;
    }

    // Read configurable thresholds from SystemSettings (admin-managed).
    const perAccountLimit = parseInt(
      (await this.runtime.getSetting('trial.perAccountLimit')) ?? '1',
      10,
    );
    const dailyGlobalLimit = parseInt(
      (await this.runtime.getSetting('trial.dailyGlobalLimit')) ?? '50',
      10,
    );

    // 1. Has the user already used their allowed trials?
    const userTrialCount = await this.prisma.subscription.count({
      where: { userId: session.userId, isTrial: true },
    });
    if (userTrialCount >= perAccountLimit) {
      await this.runtime.send(ctx, t(locale, 'trial.already'), mainMenuKeyboard(locale));
      return;
    }

    // 2. An enabled trial plan must exist (admin-configured, not hardcoded).
    const trialPlan = await this.prisma.plan.findFirst({
      where: { isTrial: true, isEnabled: true },
    });
    if (!trialPlan) {
      await this.runtime.send(ctx, t(locale, 'trial.disabled'), mainMenuKeyboard(locale));
      return;
    }

    // 3. At least one online server must be available for provisioning.
    const onlineServer = await this.prisma.server.findFirst({
      where: { status: 'ONLINE' },
      select: { id: true },
    });
    if (!onlineServer) {
      await this.runtime.send(ctx, t(locale, 'trial.no.server'), mainMenuKeyboard(locale));
      return;
    }

    // 4. Daily trial creation limit (anti-abuse). Counts trials created today.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await this.prisma.subscription.count({
      where: { isTrial: true, createdAt: { gte: startOfDay } },
    });
    if (todayCount >= dailyGlobalLimit) {
      await this.runtime.send(ctx, t(locale, 'trial.limit'), mainMenuKeyboard(locale));
      return;
    }

    // All checks pass — provision the trial subscription.
    try {
      const sub = await this.subscriptions.provision({
        userId: session.userId,
        planId: trialPlan.id,
        type: 'NEW',
        isTrial: true,
      });

      const traffic = sub.trafficLimitBytes
        ? formatTraffic(BigInt(sub.trafficLimitBytes))
        : t(locale, 'plan.unlimited');
      const days = sub.durationDays ?? 0;
      const expires = sub.expiresAt
        ? formatDate(sub.expiresAt, locale)
        : t(locale, 'plan.unlimited');

      await this.runtime.resetMenu(telegramId, 'main');

      // Show success + subscription link + connection guide (spec #1).
      await this.runtime.send(
        ctx,
        `${t(locale, 'trial.success')}\n\n${t(locale, 'trial.info', { traffic, days, expires })}`,
        mainMenuKeyboard(locale),
      );
      // Immediately show the connection guide so the user can set up the VPN.
      await this.runtime.send(
        ctx,
        `${t(locale, 'sub.guide.title')}\n\n${t(locale, 'sub.guide.body')}`,
        mainMenuKeyboard(locale),
      );

      // Audit log — trial activated (spec #13).
      await this.audit.log({
        userId: session.userId,
        action: 'ACTIVATE',
        resource: 'subscriptions',
        resourceId: sub.publicId,
        after: {
          type: 'TRIAL',
          planId: trialPlan.id.toString(),
          planName: trialPlan.name,
          trafficLimitBytes: sub.trafficLimitBytes,
          durationDays: sub.durationDays,
          expiresAt: sub.expiresAt,
        },
      });

      await this.runtime.notifyAdmins({
        title: '🎁 Trial activated',
        body: `User ${session.userId} activated a trial subscription (${sub.publicId}).`,
      });
    } catch (err: any) {
      await this.runtime.send(
        ctx,
        this.runtime.translateError(locale, err),
        mainMenuKeyboard(locale),
      );
    }
  }
}
