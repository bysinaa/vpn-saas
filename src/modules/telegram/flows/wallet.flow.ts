import { Injectable, Inject, Logger } from '@nestjs/common';
import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import type { BotLocale } from '../telegram.types';
import { walletDepositAmountsKeyboard, walletKeyboard, cryptoConfirmKeyboard, mainMenuKeyboard } from '../keyboards';
import { WalletService } from '../../wallet/wallet.service';
import { PaymentsService } from '../../payments/payments.service';
import { BankCardsService } from '../../payments/bank-cards.service';
import { IStorage, STORAGE } from '@/common/storage/storage.interface';
import { ProxyHttpService } from '@/common/proxy/proxy-http.service';
import { fromMinor, toMinor } from '@/common/utils/money.util';
import { config } from '@/config';

const TXN_PAGE_SIZE = 8;

@Injectable()
export class WalletFlow {
  private readonly logger = new Logger(WalletFlow.name);

  constructor(
    private readonly runtime: BotRuntime,
    private readonly wallet: WalletService,
    private readonly payments: PaymentsService,
    private readonly bankCards: BankCardsService,
    @Inject(STORAGE) private readonly storage: IStorage,
    private readonly proxy: ProxyHttpService,
  ) {}

  async show(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }
    const walletDto = await this.wallet.getBalance(session.userId);
    const balanceAmount = walletDto.balance; // WalletDto.balance is a string in minor units
    await this.runtime.setState(telegramId, 'wallet' as any);
    await this.runtime.pushMenu(telegramId, 'wallet');
    await this.runtime.alert(ctx);
    await this.runtime.render(
      ctx,
      t(locale, 'wallet.balance', { balance: balanceAmount, currency: 'IRR' }),
      walletKeyboard(locale),
      { parseMode: 'Markdown' },
    );
  }

  async showDepositMethods(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.setState(telegramId, 'wallet_awaiting_deposit_method' as any);
    await this.runtime.pushMenu(telegramId, 'wallet_deposit');
    await this.runtime.alert(ctx);
    // Go directly to card-to-card deposit amount selection
    await this.runtime.render(
      ctx,
      t(locale, 'wallet.deposit.amount.choose'),
      walletDepositAmountsKeyboard(locale),
    );
  }

  async onSelectDepositMethod(_ctx: Context, _method: string): Promise<void> {
    // Not used anymore — deposit goes directly to amount selection
  }

  /** Handle a pre-set deposit amount button (`wdepamt:<amount>`). */
  async onSelectPresetDepositAmount(ctx: Context, amount: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }

    // Get the default deposit card from BankCard table
    const depositCard = await this.bankCards.getDepositCard();
    if (!depositCard) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, t(locale, 'pay.card.no.card'), walletKeyboard(locale));
      return;
    }

    try {
      const payment = await this.payments.initiateWalletDeposit(session.userId, amount);

      await this.runtime.setState(telegramId, 'wallet_awaiting_receipt' as any, {
        paymentPublicId: payment.publicId,
        amount,
        currency: 'IRR',
        purpose: 'WALLET',
      });

      const holder = depositCard.cardHolder || 'Admin';
      const cardNumber = depositCard.cardNumber;
      const bankName = depositCard.bankName || '';

      await this.runtime.render(
        ctx,
        t(locale, 'wallet.deposit.card_to_card.instructions', {
          amount,
          cardNumber,
          holder,
        }) + (bankName ? `\n🏦 ${bankName}` : ''),
        { reply_markup: { inline_keyboard: [[{ text: t(locale, 'menu.cancel'), callback_data: 'wdeposit' }]] } },
        { parseMode: 'Markdown' },
      );
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Handle a receipt photo upload (card-to-card for wallet deposit). */
  async onReceiptUpload(ctx: Context, photoFileId: string): Promise<boolean> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const data = session.data ?? {};
    const paymentPublicId = data.paymentPublicId as string | undefined;
    const amount = data.amount as string | undefined;
    const currency = (data.currency as string) ?? 'IRR';
    if (!session.userId || !paymentPublicId) {
      await this.runtime.send(ctx, t(locale, 'error.generic'), mainMenuKeyboard(locale));
      return false;
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
      await this.runtime.send(ctx, t(locale, 'wallet.deposit.card_to_card.received'), mainMenuKeyboard(locale));

      // Send the actual receipt photo to all admins with user info + approve/reject buttons
      const receiptCaption =
        `🧾 Deposit Receipt Uploaded\n\n` +
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

      for (const adminId of config.telegram.adminIds) {
        try {
          await (ctx as any).telegram.sendPhoto(adminId, photoFileId, {
            caption: receiptCaption,
            reply_markup: adminKeyboard.reply_markup,
          });
        } catch (err: any) {
          this.logger.warn(`Failed to send receipt photo to admin ${adminId}: ${err?.message}`);
          try {
            await (ctx as any).telegram.sendMessage(adminId, receiptCaption, {
              reply_markup: adminKeyboard.reply_markup,
            });
          } catch {
            // ignore
          }
        }
      }
    } catch (err: any) {
      await this.runtime.send(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
    return true;
  }

  async showHistory(ctx: Context, page = 0): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }
    const result = await this.wallet.listTransactions(session.userId, {
      page: page + 1,
      limit: TXN_PAGE_SIZE,
    });
    await this.runtime.alert(ctx);
    if (!result.data.length) {
      await this.runtime.render(ctx, t(locale, 'wallet.history.empty'), mainMenuKeyboard(locale));
      return;
    }
    let msg = `${t(locale, 'wallet.history.title')}\n\n`;
    for (const tx of result.data) {
      const emoji = tx.amount.startsWith('-') ? '➖' : '➕';
      msg +=
        t(locale, 'wallet.history.item', {
          emoji,
          type: tx.type,
          amount: tx.amount,
          date: new Date(tx.createdAt).toLocaleDateString(),
          desc: tx.description ?? '',
        }) + '\n';
    }
    const totalPages = Math.max(1, Math.ceil(result.data.length / TXN_PAGE_SIZE));
    const nav: any[] = [];
    if (page > 0) nav.push({ text: '◀️', callback_data: `walletpage:${page - 1}` });
    if (page + 1 < totalPages) nav.push({ text: '▶️', callback_data: `walletpage:${page + 1}` });
    const kb = nav.length ? { reply_markup: { inline_keyboard: [nav] } } : mainMenuKeyboard(locale);
    await this.runtime.render(ctx, msg, kb);
  }

  async showGiftHistory(ctx: Context, _page = 0): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'wallet.gift.empty'), walletKeyboard(locale));
  }

  async downloadTelegramFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${filePath}`;
    const res = await this.proxy.proxyFetch(url);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}