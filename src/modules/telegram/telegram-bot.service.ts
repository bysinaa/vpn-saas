import { Injectable, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy, Logger } from '@nestjs/common';
import { Telegraf, type Context } from 'telegraf';
import { config } from '@/config';
import { PrismaService } from '@/common/prisma/prisma.service';
import { ProxyHttpService } from '@/common/proxy/proxy-http.service';
import { AuthService } from '../auth/auth.service';
import { BroadcastService } from '../notifications/broadcast.service';
import { t } from './i18n';
import type { BotLocale } from './telegram.types';
import { BOT_ACTIONS } from './telegram.types';
import { mainMenuKeyboard, languageKeyboard } from './keyboards';
import { BotRuntime } from './bot-runtime';
import { LanguageFlow } from './flows/language.flow';
import { BuyFlow } from './flows/buy.flow';
import { TrialFlow } from './flows/trial.flow';
import { VoucherFlow } from './flows/voucher.flow';
import { WalletFlow } from './flows/wallet.flow';
import { SubscriptionsFlow } from './flows/subscriptions.flow';
import { ProfileFlow } from './flows/profile.flow';
import { ReferralFlow } from './flows/referral.flow';
import { SupportFlow } from './flows/support.flow';
import { AdminFlow } from './flows/admin.flow';
import { isAdminRole } from './keyboards';

/**
 * TelegramBotService - thin Telegraf orchestrator.
 *
 * It owns the Telegraf instance (lifecycle + proxy) and routes every
 * callback query / text message to the appropriate flow handler. All
 * business logic lives in the flow classes (Clean Architecture: this
 * service never touches domain services directly).
 *
 * Callback routing convention (must match the inline keyboards exactly):
 *   lang:<locale>            -> LanguageFlow.onSelect
 *   langmenu                 -> LanguageFlow.show
 *   plan:<id>                -> BuyFlow.onSelectPlan
 *   orderproceed             -> BuyFlow.onProceed (reads orderId from session)
 *   paymethod:<METHOD>       -> BuyFlow.onSelectPaymentMethod
 *   cryptoconfirm            -> BuyFlow/WalletFlow.onCryptoConfirm (by session state)
 *   sub:<publicId>           -> SubscriptionsFlow.showDetail
 *   subpage:<n>              -> SubscriptionsFlow.showList(page)
 *   sublink:<id>             -> SubscriptionsFlow.showLink
 *   subguide:<id>            -> SubscriptionsFlow.showGuide
 *   subrenew:<id>            -> SubscriptionsFlow.confirmRenew
 *   yes:renew:<id>           -> SubscriptionsFlow.doRenew
 *   subextend:<id>           -> SubscriptionsFlow.promptExtend
 *   subupgrade:<id>          -> SubscriptionsFlow.showUpgrade
 *   upg:<subId>:<planId>     -> SubscriptionsFlow.doUpgrade
 *   subreset:<id>            -> SubscriptionsFlow.confirmReset
 *   yes:reset:<id>           -> SubscriptionsFlow.doReset
 *   subreport:<id>           -> SubscriptionsFlow.reportProblem
 *   wdeposit                 -> WalletFlow.showDepositMethods
 *   whistory                 -> WalletFlow.showHistory
 *   wgift                    -> WalletFlow.showGiftHistory
 *   depmethod:<METHOD>       -> WalletFlow.onSelectDepositMethod
 *   depamt:<amount|CUSTOM>   -> WalletFlow.onSelectDepositAmount (spec #7)
 *   crypto:<walletPublicId>  -> WalletFlow.onSelectCrypto (spec #11)
 *   voucher                  -> VoucherFlow.start (spec #5 — direct VPN activation)
 *   admin                    -> AdminFlow.show (spec #9/#10 — role-gated dashboard)
 *   adm:dash                 -> AdminFlow.showDashboard (refresh)
 *   adm:<section>            -> AdminFlow.showSection (deep-link to web panel)
 *   newticket                -> SupportFlow.startNewTicket
 *   tcat:<CAT>               -> SupportFlow.onSelectCategory
 *   tickets:<STATUS>         -> SupportFlow.showList
 *   ticket:<id>              -> SupportFlow.showDetail
 *   tkview:<id>              -> SupportFlow.viewMessages
 *   tkreply:<id>             -> SupportFlow.startReply
 *   tkclose:<id>             -> SupportFlow.closeTicket
 *   tkpage:<n>               -> SupportFlow.showList(page)
 *   profileorders            -> ProfileFlow.showOrders
 *   refrules                 -> ReferralFlow.showRules
 *   refhistory[:<n>]         -> ReferralFlow.showHistory(page)
 */
@Injectable()
export class TelegramBotService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private _bot!: Telegraf;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly proxy: ProxyHttpService,
    private readonly runtime: BotRuntime,
    private readonly language: LanguageFlow,
    private readonly buy: BuyFlow,
    private readonly trial: TrialFlow,
    private readonly voucher: VoucherFlow,
    private readonly wallet: WalletFlow,
    private readonly subs: SubscriptionsFlow,
    private readonly profile: ProfileFlow,
    private readonly referral: ReferralFlow,
    private readonly support: SupportFlow,
    private readonly admin: AdminFlow,
    private readonly broadcast: BroadcastService,
  ) {}

  get bot(): Telegraf {
    return this._bot;
  }

  async onModuleInit(): Promise<void> {
    if (!config.telegram.botToken) {
      this.logger.warn('Telegram bot token not set; bot disabled');
      return;
    }

    const agent = await this.proxy.ensureAgent();
    this._bot = new Telegraf(
      config.telegram.botToken,
      agent ? ({ telegram: { agent } } as any) : {},
    );

    if (agent) {
      this.logger.log('Telegram bot using SOCKS5 proxy agent for outbound calls');
    } else {
      this.logger.warn('Telegram bot using direct connection (no proxy agent)');
    }

    this.registerHandlers();
    this.attachErrorHandler();

    // Share the live Telegraf instance with BotRuntime so notifyAdmins() works.
    this.runtime.setBot(this._bot);
    // Also share with BroadcastService so broadcasts use the same connection.
    this.broadcast.setBot(this._bot);
  }

  /**
   * Launch the Telegram bot AFTER the HTTP server is already listening.
   *
   * IMPORTANT: NestJS runs `OnModuleInit` hooks during `NestFactory.create`
   * (i.e. BEFORE `app.listen()`). If we `await this.bot.launch()` inside
   * onModuleInit, a slow proxy / Telegram API call blocks the whole bootstrap
   * and the HTTP server never opens its port. By deferring the launch to the
   * OnApplicationBootstrap hook (which fires after `app.listen()` resolves)
   * and making the launch itself non-blocking, the HTTP API stays available
   * even if the bot takes a long time to connect.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!config.telegram.botToken || !this._bot) {
      return;
    }

    if (config.telegram.useWebhook) {
      try {
        await this.bot.telegram.setWebhook(config.telegram.webhookUrl);
        this.logger.log(`Webhook set: ${config.telegram.webhookUrl}`);
      } catch (err: any) {
        this.logger.error(`Failed to set Telegram webhook: ${err?.message ?? err}`, err?.stack);
      }
      return;
    }

    // Probe the Telegram API (getMe) through the configured agent with a short
    // timeout. If it fails or hangs (e.g. the SOCKS5 proxy can't reach
    // api.telegram.org), rebuild the Telegraf instance WITHOUT the proxy agent
    // so the bot can poll Telegram directly. This makes the bot resilient to a
    // broken proxy while still using it when it works.
    await this.ensureBotConnectivity();

    // Long-polling: launch WITHOUT awaiting so a slow connection never blocks
    // the event loop. IMPORTANT: Telegraf's launch() awaits polling.loop(),
    // which only resolves when polling STOPS (on shutdown / abort / fatal
    // 401|409). So a RESOLVED launch() means polling ended; a REJECTED launch()
    // means the idempotent setup calls (getMe/deleteWebhook) failed — usually a
    // flaky proxy dropping the TLS connection. We therefore retry launch() on
    // rejection with backoff. A successful launch() stays blocked in the
    // polling loop, so the retry only re-fires when setup fails.
    this.launchWithRetry();
  }

  /**
   * Repeatedly call bot.launch() until it stays running (polling loop active).
   * Each launch() resolves only when polling stops, or rejects when the setup
   * calls fail (flaky proxy). On rejection we back off and retry. Fatal errors
   * (401 Unauthorized / 409 Conflict — bad token or another instance polling)
   * are NOT retried because they will never succeed.
   */
  private launchWithRetry(): void {
    const MAX_ATTEMPTS = 10;
    const BASE_DELAY_MS = 2_000;
    let attempt = 0;
    const tryLaunch = (): void => {
      attempt += 1;
      this.logger.log(`Telegram bot launch attempt ${attempt}/${MAX_ATTEMPTS} (long polling)`);
      this.bot
        .launch()
        .then(() => {
          // Resolved = polling loop ended normally (shutdown). Nothing to do.
          this.logger.log('Telegram long-polling loop ended normally');
        })
        .catch((err: any) => {
          const msg: string = err?.message ?? String(err);
          const code = err?.response?.error_code ?? err?.code;
          // 401 = bad token; 409 = another getUpdates instance running. Neither
          // will recover by retrying, so stop to avoid a tight error loop.
          if (code === 401 || code === 409 || /Unauthorized|Conflict/i.test(msg)) {
            this.logger.error(
              `Telegram bot.launch() fatal error (code ${code}): ${msg} — not retrying`,
              err?.stack,
            );
            return;
          }
          this.logger.warn(
            `Telegram bot.launch() attempt ${attempt} failed: ${msg}${
              attempt < MAX_ATTEMPTS ? ' — will retry' : ' — giving up'
            }`,
          );
          if (attempt >= MAX_ATTEMPTS) {
            this.logger.error('Telegram bot launch exhausted all retries — bot will not receive updates');
            return;
          }
          const delay = BASE_DELAY_MS * Math.pow(2, Math.min(attempt - 1, 4));
          setTimeout(tryLaunch, delay);
        });
    };
    tryLaunch();
  }

  /**
   * Verify the bot can reach the Telegram API and pick the most reliable
   * transport. On some networks the SOCKS5 proxy passes short getMe calls but
   * hangs on the long-lived polling connection that bot.launch() opens, while
   * Telegram's API is directly reachable. We therefore probe a DIRECT
   * (agent-less) connection first and prefer it; only if direct fails do we
   * fall back to the proxy-configured bot built in onModuleInit.
   */
  private async ensureBotConnectivity(): Promise<void> {
    const PROBE_TIMEOUT_MS = 10_000;
    const probeWithTimeout = (bot: Telegraf): Promise<boolean> =>
      Promise.race([
        bot.telegram.getMe().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROBE_TIMEOUT_MS)),
      ]);

    // 1) Try a direct (agent-less) connection first — most reliable for polling.
    const directBot = new Telegraf(config.telegram.botToken);
    const directOk = await probeWithTimeout(directBot);
    if (directOk) {
      // Switch to the direct bot. Stop the proxy-configured instance (it has
      // not been launched yet, but stop() is a safe no-op here).
      try {
        this._bot?.stop();
      } catch {
        /* ignore */
      }
      this._bot = directBot;
      this.registerHandlers();
      this.attachErrorHandler();
      this.runtime.setBot(this._bot);
      this.broadcast.setBot(this._bot);
      this.logger.log('Telegram API reachable via direct connection (no proxy) — using direct');
      return;
    }

    // 2) Direct failed — fall back to the proxy-configured bot from onModuleInit.
    this.logger.warn(
      `Direct Telegram API probe failed/timed out (${PROBE_TIMEOUT_MS}ms). Falling back to proxy-configured bot.`,
    );
    try {
      directBot.stop();
    } catch {
      /* ignore */
    }
    const proxyOk = await probeWithTimeout(this._bot);
    if (proxyOk) {
      this.logger.log('Telegram API reachable via proxy agent — using proxy');
      return;
    }
    this.logger.error(
      'Telegram API unreachable via both direct and proxy connections — bot will not receive updates',
    );
  }

  /**
   * Attach the global error handler that logs failures and notifies the user
   * instead of leaving a dead button. Best-effort: never throws.
   */
  private attachErrorHandler(): void {
    this.bot.catch(async (err: any, ctx: any) => {
      const chatId = ctx?.chat?.id ?? ctx?.update?.message?.chat?.id;
      this.logger.error(
        `Telegram update failed${chatId ? ` (chat ${chatId})` : ''}: ${err?.message ?? err}`,
        err?.stack,
      );
      if (chatId) {
        const telegramId = ctx?.from?.id?.toString();
        const locale = telegramId
          ? await this.runtime.getLocale(telegramId).catch(() => 'fa' as BotLocale)
          : 'fa';
        const userMsg = this.runtime.translateError(locale, err) || t(locale, 'error.generic');
        await ctx?.reply?.(userMsg).catch(() => {});
if (ctx.callbackQuery) {
  await ctx?.answerCbQuery?.().catch(() => {});
}
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this._bot) {
      try {
        this._bot.stop();
      } catch {
        /* best-effort: ignore stop errors on shutdown */
      }
      this.logger.log('Telegram bot stopped');
    }
  }

  async handleUpdate(update: unknown): Promise<void> {
    await this.bot.handleUpdate(update as any);
  }

  // ---------- Handler registration ----------

  private registerHandlers(): void {
    this.bot.start(this.onStart.bind(this));
    this.bot.command('menu', this.onMenu.bind(this));
    this.bot.command('help', this.onHelp.bind(this));
    this.bot.command('cancel', this.onCancel.bind(this));

    // Language
    this.bot.action(/lang:(fa|en)/, this.onLanguageSelect.bind(this));
    this.bot.action('langmenu', this.wrap(this.language.show.bind(this.language)));

    // Main menu navigation
    this.bot.action(BOT_ACTIONS.BUY, this.wrap(this.buy.showPlans.bind(this.buy)));
    this.bot.action(BOT_ACTIONS.TRIAL, this.wrap(this.trial.start.bind(this.trial)));
    this.bot.action(BOT_ACTIONS.VOUCHER, this.wrap(this.voucher.start.bind(this.voucher)));
    this.bot.action(BOT_ACTIONS.WALLET, this.wrap(this.wallet.show.bind(this.wallet)));
    this.bot.action(BOT_ACTIONS.MY_SUBS, this.wrap(this.subs.showList.bind(this.subs)));
    this.bot.action(BOT_ACTIONS.PROFILE, this.wrap(this.profile.show.bind(this.profile)));
    this.bot.action(BOT_ACTIONS.REFERRAL, this.wrap(this.referral.show.bind(this.referral)));
    this.bot.action(BOT_ACTIONS.SUPPORT, this.wrap(this.support.show.bind(this.support)));
    this.bot.action(BOT_ACTIONS.CANCEL, this.onCancel.bind(this));
    this.bot.action(BOT_ACTIONS.BACK, this.onBack.bind(this));
    this.bot.action(BOT_ACTIONS.HOME, this.onHome.bind(this));
    this.bot.action('noop', async (ctx) => ctx.answerCbQuery().catch(() => {}));

    // Admin flow (spec #9/#10 — role-gated; AdminFlow re-checks role on every call)
    this.bot.action(BOT_ACTIONS.ADMIN, this.wrap(this.admin.show.bind(this.admin)));
    this.bot.action('adm:dash', this.wrap(this.admin.showDashboard.bind(this.admin)));
    this.bot.action(/adm:(?!dash)(.+)/, (ctx) =>
      this.admin.showSection(ctx, this.match(ctx, /adm:(.+)/)!),
    );

    // Admin CRUD actions (spec #9/#10 — manage plans/settings/panels in-bot).
    // Distinct prefixes avoid colliding with the adm:* catch-all above.
    this.bot.action(/aplan:(detail|toggle|archive|new|edit)(?::(.+))?/, (ctx) => {
      const m = (ctx.callbackQuery as any)?.data?.match(/aplan:(detail|toggle|archive|new|edit)(?::(.+))?/);
      return this.admin.onPlanAction(ctx, m![1], m![2] ?? '');
    });
    this.bot.action(/apledit:([a-zA-Z]+):(.+)/, (ctx) => {
      const m = (ctx.callbackQuery as any)?.data?.match(/apledit:([a-zA-Z]+):(.+)/);
      // Route the field-picker tap to startPlanEditField(field, publicId)
      return this.admin.onPlanAction(ctx, 'editfield', `${m![1]}:${m![2]}`);
    });
    this.bot.action(/aset:(edit|toggle|delete|new)(?::(.+))?/, (ctx) => {
      const m = (ctx.callbackQuery as any)?.data?.match(/aset:(edit|toggle|delete|new)(?::(.+))?/);
      return this.admin.onSettingAction(ctx, m![1], m![2] ?? '');
    });
    this.bot.action(/apnl:(detail|health|toggle|new)(?::(.+))?/, (ctx) => {
      const m = (ctx.callbackQuery as any)?.data?.match(/apnl:(detail|health|toggle|new)(?::(.+))?/);
      return this.admin.onPanelAction(ctx, m![1], m![2] ?? '');
    });
    // Admin broadcast confirm/cancel actions (bcast: prefix to avoid adm: catch-all)
    this.bot.action('bcast:confirm', this.wrap(this.admin.onBroadcastConfirm.bind(this.admin)));
    this.bot.action('bcast:cancel', this.wrap(this.admin.onBroadcastCancel.bind(this.admin)));
    // Admin payment manage/approve/reject (outside adm: catch-all)
    this.bot.action(/paymanage:(.+)/, (ctx) =>
      this.admin.showPaymentManage(ctx, this.match(ctx, /paymanage:(.+)/)!),
    );
    this.bot.action(/payapprove:(.+)/, (ctx) =>
      this.admin.approveReceipt(ctx, this.match(ctx, /payapprove:(.+)/)!),
    );
    this.bot.action(/payreject:(.+)/, (ctx) =>
      this.admin.rejectReceipt(ctx, this.match(ctx, /payreject:(.+)/)!),
    );

    // Buy flow
    this.bot.action(/plan:(.+)/, (ctx) => this.buy.onSelectPlan(ctx, this.match(ctx, /plan:(.+)/)!));
    this.bot.action('orderproceed', this.wrap(this.buy.onProceed.bind(this.buy)));
    this.bot.action(/paymethod:(.+)/, (ctx) =>
      this.buy.onSelectPaymentMethod(ctx, this.match(ctx, /paymethod:(.+)/)! as 'WALLET' | 'ONLINE' | 'CARD_TO_CARD' | 'CRYPTO' | 'VOUCHER'),
    );
    // "I've sent the crypto" confirm button (shared by buy + wallet deposit).
    this.bot.action('cryptoconfirm', this.wrap(this.onCryptoConfirm.bind(this)));

    // Wallet / deposit flow (walletKeyboard emits wdeposit/whistory/wgift — no voucher, spec #7)
    this.bot.action('wdeposit', this.wrap(this.wallet.showDepositMethods.bind(this.wallet)));
    this.bot.action('whistory', this.wrap(this.wallet.showHistory.bind(this.wallet)));
    this.bot.action('wgift', this.wrap(this.wallet.showGiftHistory.bind(this.wallet)));
    // Wallet deposit: pre-set amount buttons (100k / 200k / 500k)
    this.bot.action(/wdepamt:(.+)/, (ctx) => this.wallet.onSelectPresetDepositAmount(ctx, this.match(ctx, /wdepamt:(.+)/)!));

    // Subscriptions flow
    this.bot.action(/sub:(.+)/, (ctx) => this.subs.showDetail(ctx, this.match(ctx, /sub:(.+)/)!));
    this.bot.action(/subpage:(.+)/, (ctx) => this.subs.showList(ctx, Number(this.match(ctx, /subpage:(.+)/)!)));
    this.bot.action(/sublink:(.+)/, (ctx) => this.subs.showLink(ctx, this.match(ctx, /sublink:(.+)/)!));
    this.bot.action(/subguide:(.+)/, (ctx) => this.subs.showGuide(ctx, this.match(ctx, /subguide:(.+)/)!));
    this.bot.action(/subrenew:(.+)/, (ctx) => this.subs.confirmRenew(ctx, this.match(ctx, /subrenew:(.+)/)!));
    this.bot.action(/yes:renew:(.+)/, (ctx) => this.subs.doRenew(ctx, this.match(ctx, /yes:renew:(.+)/)!));
    this.bot.action(/subextend:(.+)/, (ctx) => this.subs.promptExtend(ctx, this.match(ctx, /subextend:(.+)/)!));
    this.bot.action(/subupgrade:(.+)/, (ctx) => this.subs.showUpgrade(ctx, this.match(ctx, /subupgrade:(.+)/)!));
    this.bot.action(/upg:(.+)/, (ctx) => {
      const m = ctx.callbackQuery && (ctx as any).callbackQuery!.data!.match(/upg:(.+)/);
      return this.subs.doUpgrade(ctx, m![1]);
    });
    this.bot.action(/subreset:(.+)/, (ctx) => this.subs.confirmReset(ctx, this.match(ctx, /subreset:(.+)/)!));
    this.bot.action(/yes:reset:(.+)/, (ctx) => this.subs.doReset(ctx, this.match(ctx, /yes:reset:(.+)/)!));
    this.bot.action(/subreport:(.+)/, (ctx) => this.subs.reportProblem(ctx, this.match(ctx, /subreport:(.+)/)!));

    // Support / tickets flow
    this.bot.action('newticket', this.wrap(this.support.startNewTicket.bind(this.support)));
    this.bot.action(/tcat:(.+)/, (ctx) => this.support.onSelectCategory(ctx, this.match(ctx, /tcat:(.+)/)!));
    this.bot.action(/tickets:(OPEN|CLOSED)/, (ctx) => this.support.showList(ctx, this.match(ctx, /tickets:(OPEN|CLOSED)/)! as 'OPEN' | 'CLOSED'));
    this.bot.action(/ticket:(.+)/, (ctx) => this.support.showDetail(ctx, this.match(ctx, /ticket:(.+)/)!));
    this.bot.action(/tkview:(.+)/, (ctx) => this.support.viewMessages(ctx, this.match(ctx, /tkview:(.+)/)!));
    this.bot.action(/tkreply:(.+)/, (ctx) => this.support.startReply(ctx, this.match(ctx, /tkreply:(.+)/)!));
    this.bot.action(/tkclose:(.+)/, (ctx) => this.support.closeTicket(ctx, this.match(ctx, /tkclose:(.+)/)!));
    this.bot.action(/tkpage:(.+)/, async (ctx) => {
      const data = (ctx as any).callbackQuery?.data ?? '';
      const sess = await this.runtime.getSession(ctx.from!.id.toString());
      const status = (sess.data?.ticketListStatus ?? 'OPEN') as 'OPEN' | 'CLOSED';
      const page = Number(data.split(':')[1]);
      return this.support.showList(ctx, status, page);
    });

    // Profile / referral extras
    this.bot.action('profileorders', this.wrap(this.profile.showOrders.bind(this.profile)));
    this.bot.action('refrules', this.wrap(this.referral.showRules.bind(this.referral)));
    this.bot.action(/refhistory(?::(.+))?/, (ctx) => {
      const data = (ctx as any).callbackQuery?.data ?? '';
      const page = data.includes(':') ? Number(data.split(':')[1]) : 0;
      return this.referral.showHistory(ctx, page);
    });

    // Text (reply-keyboard menu + conversational states)
    this.bot.on('text', this.onText.bind(this));
    this.bot.on('photo', this.onPhoto.bind(this));
  }

  /** Extract the first capture group from the callback data. */
  private match(ctx: Context, re: RegExp): string | null {
    const data = (ctx.callbackQuery as any)?.data ?? '';
    const m = data.match(re);
    return m ? m[1] : null;
  }

  /** Wrap a handler so a missing session userId triggers auth + retry. */
  private wrap(fn: (ctx: Context) => Promise<void>): (ctx: Context) => Promise<void> {
    return async (ctx: Context) => {
      const telegramId = ctx.from?.id?.toString()!;
      const session = await this.runtime.getSession(telegramId);
      if (!session.userId) {
        await this.ensureUser(ctx);
      }
      await fn(ctx);
    };
  }

  // ---------- Core lifecycle handlers ----------

  private async onStart(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString();
    if (!telegramId) return;
    const session = await this.runtime.getSession(telegramId);
    const locale = await this.runtime.getLocale(telegramId);
    const exists = !!session.userId;
    // If this is the configured Super Admin and they don't yet have a DB user,
    // create/promote them immediately so they see the admin menu on /start.
    if (!exists && session.data?.forceAdminMenu) {
      await this.ensureUser(ctx);
      await this.runtime.setState(telegramId, 'idle');
      await this.showMenu(ctx);
      return;
    }
    if (!exists) {
      await this.runtime.setLocale(telegramId, 'fa');
      await this.runtime.setState(telegramId, 'awaiting_language');
      const brand = await this.runtime.getBrandName();
      await ctx.reply(t('fa', 'start.welcome', { brand }), languageKeyboard());
      return;
    }
    await this.ensureUser(ctx);
    await this.showMenu(ctx);
  }

  private async onLanguageSelect(ctx: Context): Promise<void> {
    const match = (ctx.callbackQuery as any)?.data?.match(/lang:(fa|en)/);
    if (!match) return;
    const locale = match[1] as BotLocale;
    const telegramId = ctx.from?.id?.toString()!;
    // Apply the locale first so ensureUser persists the correct language.
    await this.language.onSelect(ctx, locale);
    // Onboarding: a brand-new user picks a language at /start but had no
    // account yet. Create the user now so subsequent menu buttons work.
    let session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.ensureUser(ctx);
      // ensureUser mutates+persists its own session copy; re-fetch to read it.
      session = await this.runtime.getSession(telegramId);
      if (session.userId) {
        await this.runtime.persistUserLanguage(session.userId, locale).catch(() => {});
      }
    }
    // Transition out of the onboarding state into the main menu.
    await this.runtime.setState(telegramId, 'idle');
  }

  private async ensureUser(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString();
    if (!telegramId) return;
    const session = await this.runtime.getSession(telegramId);
    if (session.userId) return;
    const result = await this.auth.mintForTelegramUser({
      telegramId,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
      username: ctx.from?.username,
      languageCode: session.locale,
    });
    session.userId = BigInt(result.user.id);
    await this.runtime.setSession(session);
  }

  private async showMenu(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
const session = await this.runtime.getSession(telegramId);
const role = session.data?.forceAdminMenu ? 'SUPER_ADMIN' : await this.getUserRole(telegramId);
    await this.runtime.resetMenu(telegramId, 'main');
    await this.runtime.setState(telegramId, 'idle');
    // Spec #7 UX: edit the existing message in place (no new message on menu tap).
    await this.runtime.editOrSend(ctx, t(locale, 'menu.title'), mainMenuKeyboard(locale, role));
  }

  /**
   * Load the caller's UserRole so the main-menu keyboard can show/hide the
   * admin button (spec #9 — role detection after login). Returns null for
   * unauthenticated users so mainMenuKeyboard renders the user-only layout.
   */
  private async getUserRole(telegramId: string): Promise<string | null> {
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { role: true },
    });
    return user?.role ?? null;
  }

  private async onMenu(ctx: Context): Promise<void> {
    await this.showMenu(ctx);
  }

  private async onHelp(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const role = await this.getUserRole(telegramId);
    // Spec #7 UX: edit-in-place (no new message). Falls back to reply when no
    // inline message exists (e.g. user typed /help as a command).
    await this.runtime.editOrSend(
      ctx,
      `${t(locale, 'menu.title')}\n\n/start - Start\n/menu - Main menu\n/cancel - Cancel current action`,
      mainMenuKeyboard(locale, role),
    );
  }

  private async onCancel(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.clearState(telegramId);
    await this.runtime.resetMenu(telegramId, 'main');
    await this.runtime.alert(ctx);
    // Spec #7 UX: edit-in-place.
    await this.runtime.editOrSend(ctx, t(locale, 'cancel'), mainMenuKeyboard(locale, await this.getUserRole(telegramId)));
  }

  private async onBack(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const prev = await this.runtime.popMenu(telegramId);
    await this.runtime.alert(ctx);
    // Route back based on the menu we popped to.
    switch (prev) {
      case 'main':
        await this.showMenu(ctx);
        break;
      case 'buy_plans':
        await this.buy.showPlans(ctx);
        break;
      case 'subs_list':
        await this.subs.showList(ctx);
        break;
      case 'wallet':
        await this.wallet.show(ctx);
        break;
      case 'support':
        await this.support.show(ctx);
        break;
      case 'profile':
        await this.profile.show(ctx);
        break;
      case 'referral':
        await this.referral.show(ctx);
        break;
      case 'admin':
        await this.admin.show(ctx);
        break;
      default:
        await this.runtime.render(ctx, t(locale, 'menu.title'), mainMenuKeyboard(locale, await this.getUserRole(telegramId)));
    }
  }

  private async onHome(ctx: Context): Promise<void> {
    await this.showMenu(ctx);
  }

  /** Route the shared "cryptoconfirm" button to buy flow. */
  private async onCryptoConfirm(ctx: Context): Promise<void> {
    await this.buy.onCryptoConfirm(ctx);
  }

  // ---------- Text + photo dispatch ----------

  private async onText(ctx: any): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const text: string | undefined = (ctx.message?.text as string)?.trim();
    const session = await this.runtime.getSession(telegramId);
    const locale = session.locale ?? 'fa';

    // Stub answerCbQuery for text updates so flow handlers don't crash.
    if (typeof ctx.answerCbQuery !== 'function') {
ctx.answerCbQuery = async () => {
  if (ctx.callbackQuery) {
    await ctx?.answerCbQuery?.().catch(() => {});
  }
};
    }

    // Onboarding guard: a brand-new user must pick a language before they can
    // use any menu button. If they somehow send text while still in the
    // awaiting_language state, re-show the language picker.
    if (session.state === 'awaiting_language' || !session.userId) {
      // Allow /start to pass through; everything else is gated.
      if (text && !text.startsWith('/')) {
        const brand = await this.runtime.getBrandName();
        await this.runtime.send(ctx, t(locale, 'start.welcome', { brand }), languageKeyboard());
        return;
      }
      // Ensure the user account exists before processing commands too.
      if (!session.userId) {
        try {
          await this.ensureUser(ctx);
          session.userId = (await this.runtime.getSession(telegramId)).userId;
        } catch (err: any) {
          this.logger.error(`ensureUser failed for ${telegramId}: ${err?.message ?? err}`, err?.stack);
        }
      }
    }

    // Conversational states take precedence over menu navigation.
    if (text) {
      // Voucher flow: code entry — direct VPN activation (spec #5).
      if (session.state === 'voucher_awaiting_code') {
        const handled = await this.voucher.onSubmitCode(ctx, text);
        if (handled) return;
      }
      // Wallet flow: no more free-text input — amounts are pre-set via buttons
      // Subscriptions flow: extend days
      if (session.state === 'subs_viewing_detail' && session.data?.pendingAction === 'extend') {
        const handled = await this.subs.onExtendDays(ctx, text);
        if (handled) return;
      }
      // Support flow: subject
      if (session.state === 'support_awaiting_subject') {
        const handled = await this.support.onSubject(ctx, text);
        if (handled) return;
      }
      // Support flow: message body
      if (session.state === 'support_awaiting_message') {
        const handled = await this.support.onMessage(ctx, text);
        if (handled) return;
      }
      // Ticket reply
      if (session.state === 'ticket_awaiting_reply') {
        const handled = await this.support.onReply(ctx, text);
        if (handled) return;
      }
      // Admin broadcast text input
      if (session.state === 'admin_broadcast_awaiting_message') {
        const handled = await this.admin.onBroadcastText(ctx, text);
        if (handled) return;
      }
      // Admin CRUD wizards (spec #9/#10 — plans/settings/panels text input)
      if (
        session.state === 'admin_plan_awaiting_field' ||
        session.state === 'admin_setting_awaiting_value' ||
        session.state === 'admin_panel_awaiting_field'
      ) {
        const handled = await this.admin.onWizardText(ctx, text);
        if (handled) return;
      }

      // Reply-keyboard menu buttons (match both locales for stale sessions).
      const matches = (key: string) => text === t('fa', key) || text === t('en', key);
      if (matches('menu.buy')) return this.buy.showPlans(ctx);
      if (matches('menu.trial')) return this.trial.start(ctx);
      if (matches('menu.voucher')) return this.voucher.start(ctx);
      if (matches('menu.wallet')) return this.wallet.show(ctx);
      if (matches('menu.subs')) return this.subs.showList(ctx);
      if (matches('menu.profile')) return this.profile.show(ctx);
      if (matches('menu.referral')) return this.referral.show(ctx);
      if (matches('menu.support')) return this.support.show(ctx);
      if (matches('menu.admin')) return this.admin.show(ctx);
      if (matches('menu.language')) {
        await this.runtime.send(ctx, t(locale, 'start.welcome', { brand: await this.runtime.getBrandName() }), languageKeyboard());
        return;
      }
      if (matches('menu.back')) return this.onBack(ctx);
      if (matches('menu.home')) return this.onHome(ctx);
      if (matches('menu.cancel')) return this.onCancel(ctx);
    }

    // /cancel command support
    if (text === '/cancel') return this.onCancel(ctx);

    // Default: show menu
    await this.showMenu(ctx);
  }

  private async onPhoto(ctx: any): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const session = await this.runtime.getSession(telegramId);
    const locale = session.locale ?? 'fa';

    if (typeof ctx.answerCbQuery !== 'function') {
      ctx.answerCbQuery = async () => {};
    }

    const photo = ctx.message?.photo;
    if (!photo?.length) return;
    // Telegram sends multiple sizes; the last is the largest.
    const photoFileId: string = photo[photo.length - 1].file_id;

    // Receipt upload for card-to-card (buy order or wallet top-up).
    // Both flows set state `wallet_awaiting_receipt`; route by the `purpose` data field.
    if (session.state === 'wallet_awaiting_receipt') {
      const purpose = session.data?.purpose as string | undefined;
      try {
        if (purpose === 'ORDER') {
          await this.buy.onReceiptUpload(ctx, photoFileId);
        } else {
          await this.wallet.onReceiptUpload(ctx, photoFileId);
        }
      } catch (err: any) {
        await this.runtime.alert(ctx);
        // Only send error message if the flow didn't already handle the response
        const role = await this.getUserRole(telegramId);
        await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale, role));
      }
      return;
    }

    // If composing a ticket message, attach the photo to the new ticket.
    if (session.state === 'support_awaiting_message') {
      // Treat the photo's caption (or a follow-up) as the message body.
      const caption = (ctx.message?.caption as string)?.trim() ?? '';
      if (caption) {
        await this.support.onMessage(ctx, caption);
      } else {
        await this.runtime.send(ctx, t(locale, 'support.message.prompt'));
      }
      return;
    }

    // Ticket reply with attachment - treat caption as the reply.
    if (session.state === 'ticket_awaiting_reply') {
      const caption = (ctx.message?.caption as string)?.trim();
      if (caption) {
        await this.support.onReply(ctx, caption);
      }
      return;
    }

    // Ignore unrecognized photos silently — don't send menu to avoid duplicate messages
  }
}
