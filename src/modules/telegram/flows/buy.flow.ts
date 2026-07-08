import { Injectable, Inject } from '@nestjs/common';
import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import type { BotLocale, PaymentMethodChoice } from '../telegram.types';
import { BOT_ACTIONS } from '../telegram.types';
import {
  plansKeyboard,
  serversKeyboard,
  confirmOrderKeyboard,
  paymentMethodKeyboard,
  onlineGatewayKeyboard,
  cryptoConfirmKeyboard,
  cancelKeyboard,
  mainMenuKeyboard,
} from '../keyboards';
import { PlansService } from '../../plans/plans.service';
import { OrdersService } from '../../orders/orders.service';
import { PaymentsService } from '../../payments/payments.service';
import { ServersService } from '../../servers/servers.service';
import { WalletService } from '../../wallet/wallet.service';
import { BankCardsService } from '../../payments/bank-cards.service';
import { IStorage, STORAGE } from '@/common/storage/storage.interface';
import { ProxyHttpService } from '@/common/proxy/proxy-http.service';
import { VpnService } from '../../vpn/vpn.service';
import { fromMinor, toMinor } from '@/common/utils/money.util';
import { config } from '@/config';
import { formatTraffic, formatDate } from '../format.util';
import type { PlanDto } from '../../plans/plans.service';

const PLANS_PAGE_SIZE = 6;
const CURRENCIES = ['USDT_TRC20', 'USDT_ERC20', 'TON', 'BTC', 'ETH'] as const;

/**
 * BuyFlow - the full purchase pipeline:
 *
 *   Show Plans → Select Plan → (Select Server) → Confirm Order →
 *   Choose Payment Method → Settle → Provision → Notify.
 *
 * Payment methods:
 *  - WALLET     : instant debit + provision (OrdersService.payWithWallet)
 *  - ONLINE     : gateway redirect, verified via callback/job
 *  - CARD_TO_CARD: user uploads receipt photo, admin verifies
 *  - CRYPTO     : address shown, verified via on-chain job
 *  - VOUCHER    : redeem code, settle order immediately
 *
 * Every step persists state to Redis so a user can resume after a disconnect.
 * All risky mutations run under the per-user lock to prevent double-click races.
 */
@Injectable()
export class BuyFlow {
  constructor(
    private readonly runtime: BotRuntime,
    private readonly plans: PlansService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly servers: ServersService,
    private readonly wallet: WalletService,
    private readonly bankCards: BankCardsService,
    @Inject(STORAGE) private readonly storage: IStorage,
    private readonly proxy: ProxyHttpService,
    private readonly vpn: VpnService,
  ) {}

  // ---------- Step 1: show available plans ----------

  /** Entry point: render the visible (non-trial) plans list. */
  async showPlans(ctx: Context, page = 0): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.send(ctx, t(locale, 'auth.required'), await this.runtime.getMainMenuKeyboard(telegramId));
      return;
    }
    await this.runtime.alert(ctx);

    // Only non-trial visible plans are purchasable here.
    const all = (await this.plans.listVisible()).filter((p) => !p.isTrial);
    if (!all.length) {
      await this.runtime.render(ctx, t(locale, 'plans.empty'), mainMenuKeyboard(locale));
      return;
    }

    const totalPages = Math.max(1, Math.ceil(all.length / PLANS_PAGE_SIZE));
    const slice = all.slice(page * PLANS_PAGE_SIZE, page * PLANS_PAGE_SIZE + PLANS_PAGE_SIZE);
    const kbPlans = slice.map((p) => ({
      publicId: p.publicId,
      name: p.name,
      priceLabel: `${p.price} ${p.currency}`,
    }));

    await this.runtime.setState(telegramId, 'buy_awaiting_plan', { subPage: page });
    await this.runtime.pushMenu(telegramId, 'buy_plans');
    await this.runtime.render(
      ctx,
      `${t(locale, 'plans.title')}\n\n${t(locale, 'plans.select')}`,
      plansKeyboard(locale, kbPlans, page, totalPages),
      { parseMode: 'Markdown' },
    );
  }

  /** Handle a plan selection callback (`plan:<publicId>`). */
  async onSelectPlan(ctx: Context, planPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const result = await this.runtime.withLock(telegramId, async () => {
      const locale = await this.runtime.getLocale(telegramId);
      const session = await this.runtime.getSession(telegramId);
      if (!session.userId) {
        await this.runtime.alert(ctx, t(locale, 'auth.required'));
        return;
      }
      const plan = (await this.plans.listVisible()).find((p) => p.publicId === planPublicId);
      if (!plan) {
        await this.runtime.alert(ctx, t(locale, 'error.not.found'));
        await this.showPlans(ctx, 0);
        return;
      }

      // Persist the chosen plan and move to the confirmation step. We do NOT
      // create the Order yet — it is created only when the user confirms, so
      // abandoned flows never leave dangling PENDING orders.
      await this.runtime.setState(telegramId, 'buy_awaiting_confirmation', {
        planPublicId: plan.publicId,
      });
      await this.runtime.pushMenu(telegramId, 'buy_confirm');
      await this.runtime.alert(ctx);
      await this.renderConfirm(ctx, plan);
    });
    if (result === undefined) {
      await this.runtime.alert(ctx, t(await this.runtime.getLocale(telegramId), 'common.loading'));
    }
  }

  /** Render the order summary + confirm keyboard for a chosen plan. */
  private async renderConfirm(ctx: Context, plan: PlanDto): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const traffic = plan.trafficLimitGb
      ? formatTraffic(BigInt(plan.trafficLimitGb) * 1024n * 1024n * 1024n)
      : t(locale, 'plan.unlimited');
    const duration = plan.durationDays ? `${plan.durationDays}d` : t(locale, 'plan.unlimited');
    const original = plan.originalPrice ? `\n${t(locale, 'plan.originalPrice', { price: plan.originalPrice })}` : '';

    const msg =
      `${t(locale, 'confirm.title')}\n\n` +
      `${t(locale, 'plan.name')}: ${plan.name}\n` +
      `${t(locale, 'plan.traffic')}: ${traffic}\n` +
      `${t(locale, 'plan.duration')}: ${duration}\n` +
      `${t(locale, 'plan.devices')}: ${plan.deviceLimit}\n` +
      `${t(locale, 'confirm.total', { amount: plan.price, currency: plan.currency })}${original}\n\n` +
      `${t(locale, 'confirm.review')}`;

    await this.runtime.render(ctx, msg, confirmOrderKeyboard(locale), { parseMode: 'Markdown' });
  }

  /** Handle "proceed to payment" — creates the order and shows payment methods. */
  async onProceed(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const result = await this.runtime.withLock(telegramId, async () => {
      const locale = await this.runtime.getLocale(telegramId);
      const session = await this.runtime.getSession(telegramId);
      if (!session.userId) {
        await this.runtime.alert(ctx, t(locale, 'auth.required'));
        return;
      }
      const planPublicId = session.data?.planPublicId as string | undefined;
      if (!planPublicId) {
        await this.runtime.alert(ctx, t(locale, 'error.generic'));
        await this.showPlans(ctx, 0);
        return;
      }

      try {
        const order = await this.orders.create({
          userId: session.userId,
          planPublicId,
          type: 'NEW',
        });
        await this.runtime.setState(telegramId, 'buy_awaiting_payment', { orderId: order.publicId });
        await this.runtime.pushMenu(telegramId, 'buy_payment');
        await this.runtime.alert(ctx);
        await this.runtime.render(
          ctx,
          `${t(locale, 'confirm.created')}\n\n${t(locale, 'confirm.total', { amount: order.totalAmount, currency: order.currency })}`,
          paymentMethodKeyboard(locale),
          { parseMode: 'Markdown' },
        );
      } catch (err: any) {
        await this.runtime.alert(ctx);
        await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
      }
    });
    if (result === undefined) {
      await this.runtime.alert(ctx, t(await this.runtime.getLocale(telegramId), 'common.loading'));
    }
  }

  // ---------- Step 2: payment method selection ----------

  /** Handle a payment-method choice (`paymethod:<METHOD>`). */
  async onSelectPaymentMethod(ctx: Context, method: PaymentMethodChoice): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const result = await this.runtime.withLock(telegramId, () => this.handlePaymentMethod(ctx, method));
    if (result === undefined) {
      await this.runtime.alert(ctx, t(await this.runtime.getLocale(telegramId), 'common.loading'));
    }
  }

  private async handlePaymentMethod(ctx: Context, method: PaymentMethodChoice): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const orderPublicId = session.data?.orderId as string | undefined;
    if (!session.userId || !orderPublicId) {
      await this.runtime.alert(ctx, t(locale, 'error.generic'));
      return;
    }

    // Spec #5: vouchers activate VPN subscriptions directly via the standalone
    // VoucherFlow and are NO LONGER a payment method for orders.
    switch (method) {
      case 'WALLET':
        return this.payWithWallet(ctx, orderPublicId);
      case 'ONLINE':
        return this.initiateOnline(ctx, orderPublicId);
      case 'CARD_TO_CARD':
        return this.initiateCardToCard(ctx, orderPublicId);
      case 'CRYPTO':
        return this.initiateCrypto(ctx, orderPublicId);
      case 'VOUCHER':
        await this.runtime.alert(ctx, t(locale, 'error.generic'));
        return;
    }
  }

  /** Pay instantly from the wallet balance and provision the subscription. */
  private async payWithWallet(ctx: Context, orderPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    try {
      await this.orders.payWithWallet(orderPublicId, session.userId!);
      await this.runtime.clearState(telegramId);
      await this.runtime.resetMenu(telegramId, 'main');
      await this.runtime.alert(ctx);
      await this.runtime.send(ctx, t(locale, 'pay.wallet.success'), mainMenuKeyboard(locale));

      await this.runtime.notifyAdmins({
        title: t('en', 'pay.notification.title'),
        body: `Wallet payment for order ${orderPublicId} by user ${session.userId}`,
      });
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Initiate an online gateway payment and show the redirect link. */
  private async initiateOnline(ctx: Context, orderPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    try {
      const payment = await this.payments.initiate({
        userId: session.userId!,
        orderPublicId,
        method: 'ONLINE',
      });
      if (!payment.redirectUrl) {
        await this.runtime.alert(ctx, t(locale, 'error.payment.failed'));
        return;
      }
      await this.runtime.alert(ctx);
      await this.runtime.render(
        ctx,
        `${t(locale, 'pay.online.redirect')}\n\n${t(locale, 'pay.online.waiting')}`,
        onlineGatewayKeyboard(locale, payment.redirectUrl),
        { parseMode: 'Markdown' },
      );
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Initiate a card-to-card payment: show merchant card + ask for receipt. */
  private async initiateCardToCard(ctx: Context, orderPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    try {
      const payment = await this.payments.initiate({
        userId: session.userId!,
        orderPublicId,
        method: 'CARD_TO_CARD',
      });
      const order = await this.orders.findOne(orderPublicId, session.userId!);

      // Read deposit card from the BankCard table (admin-managed)
      const depositCard = await this.bankCards.getDepositCard();
      if (!depositCard) {
        await this.runtime.alert(ctx);
        await this.runtime.render(ctx, t(locale, 'pay.card.no.card'), mainMenuKeyboard(locale));
        return;
      }
      const cardNumber = depositCard.cardNumber;
      const holderName = depositCard.cardHolder || 'Admin';
      const bankName = depositCard.bankName || '';

      await this.runtime.setState(telegramId, 'wallet_awaiting_receipt', {
        orderId: orderPublicId,
        paymentPublicId: payment.publicId,
        amount: order.totalAmount,
        currency: order.currency,
        purpose: 'ORDER',
      });
      await this.runtime.alert(ctx);
      await this.runtime.render(
        ctx,
        `${t(locale, 'pay.card.title')}\n\n` +
          t(locale, 'pay.card.instructions', {
            amount: order.totalAmount,
            currency: order.currency,
            cardNumber,
            holder: holderName,
          }) + (bankName ? `\n🏦 ${bankName}` : ''),
        cancelKeyboard(locale),
        { parseMode: 'Markdown' },
      );
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Initiate a crypto payment: show address + confirm button. */
  private async initiateCrypto(ctx: Context, orderPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    try {
      // Default to USDT_TRC20 (cheapest/most common). User can request others via future menu.
      const cryptoCurrency = (session.data?.cryptoCurrency as typeof CURRENCIES[number]) ?? 'USDT_TRC20';
      const payment = await this.payments.initiate({
        userId: session.userId!,
        orderPublicId,
        method: 'CRYPTO',
        cryptoCurrency,
      });
      const order = await this.orders.findOne(orderPublicId, session.userId!);

      // Look up the deposit address from SystemSetting (same convention as PaymentsService).
      const addressRow = await this.runtime.getSetting(`payment.crypto.${cryptoCurrency.toLowerCase()}.address`);
      if (!addressRow) {
        await this.runtime.alert(ctx, t(locale, 'pay.crypto.no.address'));
        return;
      }
      await this.runtime.setState(telegramId, 'wallet_awaiting_crypto_confirm', {
        orderId: orderPublicId,
        paymentPublicId: payment.publicId,
        amount: order.totalAmount,
        currency: order.currency,
        cryptoCurrency,
        purpose: 'ORDER',
      });
      await this.runtime.alert(ctx);
      await this.runtime.render(
        ctx,
        `${t(locale, 'pay.crypto.title')}\n\n` +
          t(locale, 'pay.crypto.instructions', {
            amount: order.totalAmount,
            currency: cryptoCurrency,
            address: addressRow,
          }),
        cryptoConfirmKeyboard(locale),
        { parseMode: 'Markdown' },
      );
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Handle the "I have sent the crypto" confirm button. */
  async onCryptoConfirm(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.clearState(telegramId);
    await this.runtime.resetMenu(telegramId, 'main');
    await this.runtime.alert(ctx);
    await this.runtime.render(
      ctx,
      `${t(locale, 'pay.crypto.waiting')}`,
      mainMenuKeyboard(locale),
      { parseMode: 'Markdown' },
    );
  }

  /** Handle a receipt photo upload (card-to-card for an order). */
  async onReceiptUpload(ctx: Context, photoFileId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const data = session.data ?? {};
    const paymentPublicId = data.paymentPublicId as string | undefined;
    const amount = data.amount as string | undefined;
    const currency = (data.currency as string) ?? 'USD';
    if (!session.userId || !paymentPublicId) {
      await this.runtime.send(ctx, t(locale, 'error.generic'), mainMenuKeyboard(locale));
      return;
    }

    try {
      const fileLink = await (ctx as any).telegram.getFile(photoFileId);
      const buffer = await this.downloadTelegramFile(fileLink.file_path);
      const payerName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || ctx.from?.username || 'Unknown';
      const uploaded = await this.storage.upload({
        key: `receipts/${session.userId}/${Date.now()}-${photoFileId}.jpg`,
        body: buffer,
        mimeType: 'image/jpeg',
        isPublic: false,
      });
      await this.payments.submitReceipt({
        userId: session.userId,
        paymentPublicId,
        payerName,
        amount: amount ? toMinor(amount) : undefined,
        fileUrl: uploaded.url,
        fileKey: uploaded.key,
        mimeType: uploaded.mimeType,
        fileSize: uploaded.size,
      });
      await this.runtime.clearState(telegramId);
      await this.runtime.resetMenu(telegramId, 'main');
      await this.runtime.send(ctx, t(locale, 'pay.card.uploaded'), mainMenuKeyboard(locale));

      // Send the actual receipt photo to all admins with user info + approve/reject buttons
      const receiptCaption =
        `🧾 Receipt Uploaded\n\n` +
        `User: ${payerName}` +
        (ctx.from?.username ? ` (@${ctx.from?.username})` : '') +
        `\nTelegram ID: ${telegramId}` +
        `\nPayment: ${paymentPublicId}` +
        `\nAmount: ${amount ?? 'N/A'} ${currency}`;

      const adminKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ تایید و شارژ', `payapprove:${paymentPublicId}`),
          Markup.button.callback('❌ رد رسید', `payreject:${paymentPublicId}`),
        ],
        [Markup.button.callback('🔍 مدیریت', `paymanage:${paymentPublicId}`)],
      ]);

      // Fire-and-forget: send receipt to admins WITHOUT blocking the handler.
      // Photo forwarding through the SOCKS5 proxy can be very slow; blocking
      // here causes a 90s timeout on the entire Telegram update.
      void (async () => {
        for (const adminId of config.telegram.adminIds) {
          try {
            await (ctx as any).telegram.sendPhoto(adminId, photoFileId, {
              caption: receiptCaption,
              ...adminKeyboard,
            });
          } catch (err: any) {
            // Fallback to text notification if photo send fails
            try {
              await (ctx as any).telegram.sendMessage(adminId, receiptCaption, adminKeyboard);
            } catch {
              // ignore
            }
          }
        }
      })();
    } catch (err: any) {
      await this.runtime.send(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Download a Telegram file via the bot's getFile + download stream (uses proxy). */
  private async downloadTelegramFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${filePath}`;
    const res = await this.proxy.proxyFetch(url);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
