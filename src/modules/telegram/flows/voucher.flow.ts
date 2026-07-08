import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import { mainMenuKeyboard, cancelKeyboard, navKeyboard } from '../keyboards';
import { VouchersService } from '../../payments/vouchers.service';
import { formatTraffic, formatDate } from '../format.util';

/**
 * VoucherFlow (spec #5) — standalone voucher redemption.
 *
 * Vouchers NO LONGER pay for orders and NO LONGER top up the wallet. They
 * activate a VPN subscription DIRECTLY:
 *
 *   User taps "Redeem Voucher" → enters 10-char code →
 *   VouchersService.redeem() validates + provisions a subscription inside a
 *   DB transaction (marking the voucher USED with the user's telegramId / IP
 *   / timestamp) → after commit the VPN panel user is created asynchronously
 *   → the bot shows the subscription link + connection guide.
 *
 * The service is the source of truth for all validation, transactional
 * safety and audit logging; this flow is a thin Telegraf adapter.
 */
@Injectable()
export class VoucherFlow {
  constructor(
    private readonly runtime: BotRuntime,
    private readonly prisma: PrismaService,
    private readonly vouchers: VouchersService,
  ) {}

  /** Entry point: prompt the user to type a voucher code. */
  async start(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }
    await this.runtime.setState(telegramId, 'voucher_awaiting_code');
    await this.runtime.pushMenu(telegramId, 'voucher');
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'pay.voucher.prompt'), cancelKeyboard(locale));
  }

  /**
   * Handle a voucher code submitted as free text. Returns true when the text
   * was consumed (state was `voucher_awaiting_code`), false otherwise, so the
   * text dispatcher can fall through to other handlers.
   */
  async onSubmitCode(ctx: Context, text: string): Promise<boolean> {
    const telegramId = ctx.from?.id?.toString()!;
    const session = await this.runtime.getSession(telegramId);
    if (session.state !== 'voucher_awaiting_code') {
      return false;
    }
    const locale = await this.runtime.getLocale(telegramId);

    const result = await this.runtime.withLock(telegramId, async () => {
      const fresh = await this.runtime.getSession(telegramId);
      if (!fresh.userId) return;
      const code = (text || '').trim();
      if (!code) {
        await this.runtime.send(ctx, t(locale, 'pay.voucher.invalid'), cancelKeyboard(locale));
        return;
      }

      try {
        const redeemed = await this.vouchers.redeem(code, {
          userId: fresh.userId,
          telegramId,
          ip: (ctx as any).message?.from ? undefined : undefined,
        });

        await this.runtime.clearState(telegramId);
        await this.runtime.resetMenu(telegramId, 'main');

        // Fetch the freshly-provisioned subscription so we can show the link
        // + traffic / expiry + connection guide (spec #5).
        const sub = await this.prisma.subscription.findUnique({
          where: { id: BigInt(redeemed.subscriptionId) },
          include: { vpnUser: true },
        });
        const link = sub?.subscriptionLink ?? sub?.vpnUser?.subLink ?? null;
        const traffic = sub?.trafficLimitBytes
          ? formatTraffic(BigInt(sub.trafficLimitBytes))
          : t(locale, 'plan.unlimited');
        const expires = sub?.expiresAt ? formatDate(sub.expiresAt, locale) : t(locale, 'plan.unlimited');
        const days = sub?.durationDays ?? 0;

        const linkLine = link ? `\n\n🔗 \`${link}\`` : '';
        await this.runtime.send(
          ctx,
          `${t(locale, 'pay.voucher.success')}\n\n${t(locale, 'trial.info', { traffic, days, expires })}${linkLine}`,
          mainMenuKeyboard(locale),
          'Markdown',
        );
        // Immediately show the connection guide (mirrors the trial flow).
        await this.runtime.send(
          ctx,
          `${t(locale, 'sub.guide.title')}\n\n${t(locale, 'sub.guide.body')}`,
          mainMenuKeyboard(locale),
          'Markdown',
        );

        await this.runtime.notifyAdmins({
          title: '🎟 Voucher redeemed',
          body: `User ${fresh.userId} redeemed voucher ${redeemed.voucher.code} → subscription ${redeemed.subscriptionPublicId} (${redeemed.planName}).`,
        });
      } catch (err: any) {
        await this.runtime.send(
          ctx,
          this.runtime.translateError(locale, err),
          cancelKeyboard(locale),
        );
      }
    });
    if (result === undefined) {
      await this.runtime.alert(ctx, t(locale, 'common.loading'));
    }
    return true;
  }
}
