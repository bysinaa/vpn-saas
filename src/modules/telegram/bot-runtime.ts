import { Injectable, Logger } from '@nestjs/common';
import type { Context } from 'telegraf';
import { Telegraf } from 'telegraf';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/redis/redis.service';
import { config } from '@/config';
import { t } from './i18n';
import type { BotLocale, BotMenu, BotSession, BotState } from './telegram.types';
import { mainMenuKeyboard, isAdminRole } from './keyboards';

const SESSION_TTL = 3600; // 1h idle timeout — session resumes if user returns within window

/**
 * BotRuntime - the shared foundation every flow handler depends on.
 *
 * Responsibilities:
 *  - Load/persist per-user session state in Redis (stateless, horizontally scalable).
 *  - Provide a per-user async lock to prevent double-click races.
 *  - Edit-in-place: reuse the last inline message instead of spamming new ones.
 *  - Send notifications to the configured admin Telegram ids.
 *  - Stash the "current menu" so Back/Home navigation always lands somewhere sane.
 *
 * Keeping these concerns in one place means individual flow files stay focused
 * on business logic instead of Telegram API plumbing.
 */
@Injectable()
export class BotRuntime {
  private readonly logger = new Logger(BotRuntime.name);
  /** In-process per-user locks; prevents concurrent handler execution. */
  private readonly locks = new Map<string, Promise<void>>();

  /** The shared Telegraf instance — set once during onApplicationBootstrap. */
  private _bot!: Telegraf;
  private botUsername: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Called by TelegramBotService to inject the live Telegraf bot instance. */
  setBot(bot: Telegraf): void {
    this._bot = bot;
  }

  setBotUsername(username?: string | null): void {
    this.botUsername = username?.replace(/^@/, '') ?? null;
  }

  getBotUsername(): string | null {
    return this.botUsername;
  }

  buildReferralLink(referralCode: string): string {
    if (!this.botUsername) {
      throw new Error('Telegram bot username is not initialized');
    }
    return `https://t.me/${this.botUsername}?start=${encodeURIComponent(referralCode)}`;
  }

  // ---------- Session ----------

  /** Load the session for a Telegram user, hydrating BigInts. */
  async getSession(telegramId: string): Promise<BotSession> {
    const raw = await this.redis.getJson<BotSession & { userId?: string }>(
      `bot:session:${telegramId}`,
    );
    if (!raw) {
      const user = await this.prisma.user.findUnique({
        where: { telegramId },
        select: { id: true, role: true },
      });

      const normalize = (s?: string) => (s ? s.trim().replace(/^\+/, '') : '');
      const isConfiguredSuperAdmin = normalize(config.superAdmin.telegramId) === normalize(telegramId);
      return {
        telegramId,
        state: 'idle',
        menuStack: ['main'],
        userId: user?.id ? BigInt(user.id) : undefined,
        data: isConfiguredSuperAdmin ? { forceAdminMenu: true } : undefined,
      };
    }
    return {
      ...raw,
      userId: raw.userId ? BigInt(raw.userId) : undefined,
      menuStack: raw.menuStack ?? ['main'],
    };
  }

  /** Persist the session (BigInt -> string for JSON). */
  async setSession(session: BotSession): Promise<void> {
    const { userId, ...rest } = session;
    await this.redis.setJson(
      `bot:session:${session.telegramId}`,
      { ...rest, userId: userId?.toString() },
      SESSION_TTL,
    );
  }

  /** Clear conversational state but keep identity + locale. */
  async clearState(telegramId: string): Promise<BotSession> {
    const session = await this.getSession(telegramId);
    session.state = 'idle';
    session.data = undefined;
    session.menuStack = ['main'];
    await this.setSession(session);
    return session;
  }

  /** Transition to a new state, persisting immediately. */
  async setState(telegramId: string, state: BotState, data?: Record<string, unknown>): Promise<BotSession> {
    const session = await this.getSession(telegramId);
    session.state = state;
    session.data = { ...session.data, ...data };
    await this.setSession(session);
    return session;
  }

  async getLocale(telegramId: string): Promise<BotLocale> {
    const session = await this.getSession(telegramId);
    return session.locale ?? 'fa';
  }

  async setLocale(telegramId: string, locale: BotLocale): Promise<void> {
    const session = await this.getSession(telegramId);
    session.locale = locale;
    await this.setSession(session);
  }

  /** Persist the user's language on their User row (shared with the web app). */
  async persistUserLanguage(userId: bigint, locale: BotLocale): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { language: locale === 'fa' ? 'FA' : 'EN' },
    });
  }

  // ---------- Menu stack (Back navigation) ----------

  async pushMenu(telegramId: string, menu: BotMenu): Promise<void> {
    const session = await this.getSession(telegramId);
    session.menuStack = session.menuStack ?? ['main'];
    if (session.menuStack[session.menuStack.length - 1] !== menu) {
      session.menuStack.push(menu);
    }
    await this.setSession(session);
  }

  async popMenu(telegramId: string): Promise<BotMenu> {
    const session = await this.getSession(telegramId);
    session.menuStack = session.menuStack ?? ['main'];
    if (session.menuStack.length > 1) session.menuStack.pop();
    await this.setSession(session);
    return session.menuStack[session.menuStack.length - 1] ?? 'main';
  }

  async peekMenu(telegramId: string): Promise<BotMenu> {
    const session = await this.getSession(telegramId);
    const stack = session.menuStack ?? ['main'];
    return stack[stack.length - 1] ?? 'main';
  }

  async resetMenu(telegramId: string, menu: BotMenu = 'main'): Promise<void> {
    const session = await this.getSession(telegramId);
    session.menuStack = [menu];
    await this.setSession(session);
  }

  // ---------- Per-user lock (prevent double-clicks) ----------

  /**
   * Run `fn` while holding a per-user lock. If the same user taps a button
   * twice quickly, the second invocation is short-circuited (we answer the
   * callback with a "please wait" toast). This prevents duplicate orders,
   * duplicate payments, and race conditions on wallet mutations.
   */
  async withLock<T>(telegramId: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.locks.has(telegramId)) {
      return undefined;
    }
    let resolve!: () => void;
    const p = new Promise<void>((r) => (resolve = r));
    this.locks.set(telegramId, p);
    try {
      return await fn();
    } finally {
      this.locks.delete(telegramId);
      resolve();
    }
  }

  // ---------- Message rendering ----------

  /**
   * Edit the last inline message in place if possible, else send a new reply.
   * This keeps the chat clean (UX requirement) and works around Telegram's
   * "message is not modified" edge case.
   */
  async render(
    ctx: Context,
    text: string,
    keyboard?: any,
    opts: { parseMode?: 'Markdown' | 'HTML' } = {},
  ): Promise<void> {
    await this.editOrSend(ctx, text, keyboard, opts);
  }

  /**
   * The canonical edit-in-place renderer (spec #7 UX: never spam new messages).
   *
   * Behaviour:
   *  - If invoked from a callback_query, ALWAYS answerCbQuery (no "loading" spinner).
   *  - Edit the originating inline message text+keyboard in place.
   *  - If edit fails with "message is not modified", no-op (already correct).
   *  - If there is no inline message to edit (text command / first render),
   *    send a brand-new message.
   *
   * This is what every flow should call so taps always reuse the same bubble.
   */
  async editOrSend(
    ctx: Context,
    text: string,
    keyboard?: any,
    opts: { parseMode?: 'Markdown' | 'HTML' } = {},
  ): Promise<void> {
    // Always answer the callback query first so the spinner stops (no-op on text).
    await this.alert(ctx);

    const cb = ctx.callbackQuery as any;
    const messageId = cb?.message?.message_id;
    const chatId = (ctx as any).chat?.id;
    const inlineMessageId = cb?.inline_message_id;

    const extra: any = {};
    if (keyboard?.reply_markup) extra.reply_markup = keyboard.reply_markup;
    else if (keyboard) extra.reply_markup = keyboard;
    if (opts.parseMode) extra.parse_mode = opts.parseMode;

    // Prefer editing the originating inline message in place.
    if ((messageId || inlineMessageId) && chatId) {
      try {
        await ctx.telegram.editMessageText(
          chatId,
          messageId ?? undefined,
          inlineMessageId ?? undefined,
          text,
          extra,
        );
        return;
      } catch (err: any) {
        const desc = err?.description ?? err?.message ?? '';
        if (desc.includes('not modified')) return; // already correct — success
        // "message can't be edited" / too old / media mismatch -> fall back to a new send.
        this.logger.debug?.(`editMessageText fell back to reply: ${desc}`);
      }
    }
    await ctx.reply(text, { ...extra });
  }

  /** Update only the inline keyboard of the current message (cheaper than editOrSend). */
  async editKeyboard(ctx: Context, keyboard: any): Promise<void> {
    await this.alert(ctx);
    const cb = ctx.callbackQuery as any;
    const messageId = cb?.message?.message_id;
    const chatId = (ctx as any).chat?.id;
    const inlineMessageId = cb?.inline_message_id;
    if ((messageId || inlineMessageId) && chatId) {
      try {
        await ctx.telegram.editMessageReplyMarkup(
          chatId,
          messageId ?? undefined,
          inlineMessageId ?? undefined,
          keyboard?.reply_markup ?? keyboard,
        );
        return;
      } catch (err: any) {
        const desc = err?.description ?? err?.message ?? '';
        if (desc.includes('not modified')) return;
        this.logger.debug?.(`editMessageReplyMarkup fell back: ${desc}`);
      }
    }
    await ctx.reply('〰️', { ...keyboard });
  }

  /** Send a brand-new message (when a clean slate is needed). */
  async send(ctx: Context, text: string, keyboard?: any, parseMode?: 'Markdown' | 'HTML'): Promise<void> {
    const extra: any = {};
    if (keyboard?.reply_markup) extra.reply_markup = keyboard.reply_markup;
    else if (keyboard) extra.reply_markup = keyboard;
    if (parseMode) extra.parse_mode = parseMode;
    await ctx.reply(text, { ...extra });
  }

  /** Answer a callback query toast (best-effort, safe for text updates too). */
  async alert(ctx: Context, text?: string, showAlert = false): Promise<void> {
    try {
      // Telegraf's answerCbQuery is typed to require callback_query_id when
      // an options object is passed, but on a callback_query update it is
      // already known from the context. Cast to a permissive signature.
      const fn = ctx.answerCbQuery as unknown as (opts?: {
        text?: string;
        show_alert?: boolean;
      }) => Promise<unknown>;
      await fn({ text, show_alert: showAlert });
    } catch {
      // ignore — happens for text updates where cb query is absent
    }
  }

  // ---------- Admin notifications ----------

  /** Notify all configured admin Telegram ids directly via the Telegram bot API. */
  async notifyAdmins(payload: {
    title: string;
    body: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    if (!this._bot) {
      this.logger.warn('Cannot notify admins: bot not initialized');
      return;
    }
    const text = `${payload.title}\n\n${payload.body}`;
    for (const adminId of config.telegram.adminIds) {
      try {
        await this._bot.telegram.sendMessage(adminId, text);
      } catch (err: any) {
        this.logger.warn(`Failed to notify admin ${adminId}: ${err?.message}`);
      }
    }
  }

  /** Send a direct Telegram message to a specific chat id (used for admin alerts). */
  async sendTelegram(chatId: string, text: string): Promise<void> {
    if (!this._bot) {
      this.logger.warn('Cannot send telegram: bot not initialized');
      return;
    }
    await this._bot.telegram.sendMessage(chatId, text);
  }

  /** Send a photo to a specific chat id (used for sending receipts to admins). */
  async sendPhoto(chatId: string, fileId: string, caption?: string): Promise<void> {
    if (!this._bot) {
      this.logger.warn('Cannot send photo: bot not initialized');
      return;
    }
    await this._bot.telegram.sendPhoto(chatId, fileId, { caption });
  }

  // ---------- System settings ----------

  /** Read a SystemSetting value by key (returns null if absent). */
  async getSetting(key: string): Promise<string | null> {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key } });
    return (setting?.value as string) ?? null;
  }

  // ---------- Branding ----------

  async getBrandName(): Promise<string> {
    return (await this.getSetting('brand.name')) ?? config.app.name;
  }

  // ---------- Main menu ----------

  /**
   * Build the correct main-menu keyboard for the given user, fetching
   * their role from the database so admins see only the admin panel
   * button and regular users see user-specific options.
   */
  async getMainMenuKeyboard(telegramId: string): Promise<any> {
    const locale = await this.getLocale(telegramId);
    const session = await this.getSession(telegramId);
    const normalize = (s?: string) => (s ? s.trim().replace(/^\+/, '') : '');
    const isConfiguredSuperAdmin = normalize(config.superAdmin.telegramId) === normalize(telegramId);

    if (isConfiguredSuperAdmin) {
      return mainMenuKeyboard(locale, 'SUPER_ADMIN');
    }

    if (!session.userId) {
      // Not yet authenticated — return the user layout (no admin panel).
      return mainMenuKeyboard(locale);
    }
    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { role: true },
    });
    return mainMenuKeyboard(locale, user?.role ?? null);
  }

  // ---------- Error formatting ----------

  /** Map a thrown error to a localized, user-friendly message. */
  translateError(locale: BotLocale, err: any): string {
    const code = err?.code ?? err?.name;
    switch (code) {
      case 'WALLET_INSUFFICIENT_FUNDS':
        return t(locale, 'pay.wallet.insufficient');
      case 'TRIAL_ALREADY_USED':
        return t(locale, 'trial.already');
      case 'SUBSCRIPTION_EXPIRED':
        return t(locale, 'error.expired.sub');
      case 'SERVER_MAINTENANCE':
      case 'PANEL_API_ERROR':
        return t(locale, 'error.sanity');
      case 'PAYMENT_REJECTED':
      case 'RECEIPT_REJECTED':
        return t(locale, 'error.payment.failed');
      case 'VOUCHER_INVALID':
      case 'VOUCHER_EXPIRED':
        return t(locale, 'pay.voucher.invalid');
      case 'NOT_FOUND':
        return t(locale, 'error.not.found');
      case 'CONFLICT':
        return err?.message ?? t(locale, 'error.duplicate');
      default:
        this.logger.error?.(`Unhandled bot error: ${err?.message ?? err}`, err?.stack);
        return t(locale, 'error.generic');
    }
  }
}
