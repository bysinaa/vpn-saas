import { Inject, Injectable, Logger } from '@nestjs/common';
import { Markup, type Context } from 'telegraf';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import type { BotLocale, BotState } from '../telegram.types';
import { AdminService } from '../../admin/admin.service';
import { fromMinor } from '@/common/utils/money.util';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BankCardsService, maskCardNumber } from '../../payments/bank-cards.service';
import { CryptoWalletsService } from '../../payments/crypto-wallets.service';
import { VouchersService } from '../../payments/vouchers.service';
import { PlansService } from '../../plans/plans.service';
import { SettingsService } from '../../settings/settings.service';
import { BroadcastService } from '../../notifications/broadcast.service';
import { VpnService } from '../../vpn/vpn.service';
import { PaymentsService } from '../../payments/payments.service';
import { config } from '@/config';
import type { CryptoCurrency } from '@prisma/client';
import { IStorage, STORAGE } from '@/common/storage/storage.interface';

type MandatoryJoinChannel = { chatId: string; title: string; url: string };

/**
 * AdminFlow (spec #9, #10) — fully in-bot admin panel.
 *
 * Every interaction EDITS THE CURRENT MESSAGE IN PLACE (spec #7 UX): no new
 * messages are sent on button taps. Each management section renders a real
 * inline list/detail view — no dead web links. Role is re-checked on every
 * invocation (defence in depth).
 */
@Injectable()
export class AdminFlow {
  private readonly logger = new Logger(AdminFlow.name);

  constructor(
    private readonly runtime: BotRuntime,
    private readonly admin: AdminService,
    private readonly prisma: PrismaService,
    private readonly bankCards: BankCardsService,
    private readonly cryptoWallets: CryptoWalletsService,
    private readonly vouchers: VouchersService,
    private readonly plans: PlansService,
    private readonly settings: SettingsService,
    private readonly broadcast: BroadcastService,
    private readonly vpn: VpnService,
    private readonly payments: PaymentsService,
    @Inject(STORAGE) private readonly storage: IStorage,
  ) {}

  // small helper: safely extract telegram id string or null (avoid non-null asserted optional chains)
  private getTelegramId(ctx: Context): string | null {
    return ctx?.from && typeof ctx.from.id !== 'undefined' && ctx.from.id !== null
      ? String(ctx.from.id)
      : null;
  }

  // ===========================================================================
  // Entry points
  // ===========================================================================

  /** Entry point: render the admin dashboard menu (role-checked). */
  async show(ctx: Context): Promise<void> {
    await this.renderDashboard(ctx);
  }

  /** Refresh the dashboard stats view (`adm:dash`). */
  async showDashboard(ctx: Context): Promise<void> {
    await this.renderDashboard(ctx, true);
  }

  /** Route a section tap to its dedicated in-bot view. */
  async showSection(ctx: Context, section: string): Promise<void> {
    const handlers: Record<string, (c: Context) => Promise<void>> = {
      users: this.viewUsers,
      pay: this.viewPayments,
      cards: this.viewBankCards,
      wallet: this.viewWalletOps,
      plans: this.viewPlans,
      vouchers: this.viewVouchers,
      ref: this.viewReferrals,
      trial: this.viewTrialSettings,
      crypto: this.viewCryptoWallets,
      gateway: this.viewGateway,
      join: this.viewMandatoryJoin,
      broadcast: this.viewBroadcast,
      tickets: this.viewTickets,
      edu: this.viewEducation,
      settings: this.viewSettings,
      stats: this.viewStatistics,
      logs: this.viewAuditLogs,
      roles: this.viewRoles,
    };
    const handler = handlers[section];
    if (handler) {
      await handler.call(this, ctx);
    } else {
      await this.renderDashboard(ctx, true);
    }
  }

  // ===========================================================================
  // CRUD action dispatchers — invoked by aps:*/aplan:*/aset:* handlers
  // registered in telegram-bot.service.ts. All edit-in-place.
  // ===========================================================================

  /** Dispatch a `aplan:<verb>:<id>` plan-management action. */
  async onPlanAction(ctx: Context, verb: string, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.runtime.alert(ctx);
    try {
      switch (verb) {
        case 'detail':
          await this.viewPlanDetail(ctx, publicId);
          break;
        case 'toggle':
          await this.togglePlanVisibility(ctx, publicId);
          break;
        case 'archive':
          await this.archivePlan(ctx, publicId);
          break;
        case 'new':
          await this.startPlanWizard(ctx);
          break;
        case 'edit':
          await this.startPlanEdit(ctx, publicId);
          break;
        case 'editfield': {
          // Combined payload "field:publicId" from the apledit: handler.
          const sep = publicId.indexOf(':');
          const field = sep > 0 ? publicId.slice(0, sep) : '';
          const id = sep > 0 ? publicId.slice(sep + 1) : '';
          if (field && id) {
            await this.startPlanEditField(ctx, id, field);
          } else {
            await this.viewPlans(ctx);
          }
          break;
        }
        default:
          await this.viewPlans(ctx);
      }
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  async onVoucherAction(ctx: Context, verb: string, publicId = ''): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.runtime.alert(ctx);
    try {
      if (verb === 'new') {
        await this.startVoucherWizard(ctx);
      } else if (verb === 'plan' && publicId) {
        await this.selectVoucherPlan(ctx, publicId);
      } else {
        await this.viewVouchers(ctx);
      }
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  /** Dispatch a `aset:<verb>:<key>` setting-management action. */
  async onSettingAction(ctx: Context, verb: string, key: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.runtime.alert(ctx);
    try {
      switch (verb) {
        case 'edit':
          await this.startSettingEdit(ctx, key);
          break;
        case 'toggle':
          await this.toggleSetting(ctx, key);
          break;
        case 'delete':
          await this.deleteSetting(ctx, key);
          break;
        case 'new':
          await this.startSettingCreate(ctx);
          break;
        default:
          await this.viewSettings(ctx);
      }
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  /** Card administration callbacks are role-checked again at execution time. */
  async onCardAction(ctx: Context, verb: string, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    try {
      if (verb === 'detail') {
        await this.viewBankCardDetail(ctx, publicId);
      } else if (verb === 'new') {
        await this.startCardCreate(ctx);
      } else if (verb === 'confirmDelete') {
        await this.confirmCardDelete(ctx, publicId);
      } else {
        const adminId = await this.getAdminUserId(ctx);
        if (!adminId) return;
        if (verb === 'toggle') {
          const current = await this.bankCards.findOne(publicId);
          await this.bankCards.setActive(publicId, !current.isActive, adminId);
        } else if (verb === 'default') {
          await this.bankCards.setDefault(publicId, adminId);
        } else if (verb === 'delete') {
          await this.bankCards.remove(publicId, adminId);
          await this.runtime.alert(ctx, '✅ کارت غیرفعال شد.');
          await this.viewBankCards(ctx);
          return;
        }
        await this.runtime.alert(ctx, '✅ ذخیره شد.');
        await this.viewBankCardDetail(ctx, publicId);
      }
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  async onCardEditField(ctx: Context, field: string, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.startPaymentFieldWizard(
      ctx,
      'card_edit',
      'admin_card_awaiting_field',
      field,
      publicId,
    );
  }

  async onCryptoAction(ctx: Context, verb: string, value: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    try {
      if (verb === 'detail') {
        await this.viewCryptoWalletDetail(ctx, value);
      } else if (verb === 'choose') {
        await this.startCryptoCreate(ctx, value as CryptoCurrency);
      } else if (verb === 'new') {
        await this.chooseCryptoCurrency(ctx);
      } else if (verb === 'confirmDelete') {
        await this.confirmCryptoDelete(ctx, value);
      } else {
        const adminId = await this.getAdminUserId(ctx);
        if (!adminId) return;
        if (verb === 'toggle') {
          const current = await this.cryptoWallets.findOne(value);
          await this.cryptoWallets.setActive(value, !current.isActive, adminId);
        } else if (verb === 'default') {
          await this.cryptoWallets.setDefault(value, adminId);
        } else if (verb === 'delete') {
          await this.cryptoWallets.remove(value, adminId);
          await this.runtime.alert(ctx, '✅ مقصد رمزارز حذف شد.');
          await this.viewCryptoWallets(ctx);
          return;
        }
        await this.runtime.alert(ctx, '✅ ذخیره شد.');
        await this.viewCryptoWalletDetail(ctx, value);
      }
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  async onCryptoEditField(ctx: Context, field: string, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.startPaymentFieldWizard(
      ctx,
      'crypto_edit',
      'admin_crypto_awaiting_field',
      field,
      publicId,
    );
  }

  async onGatewayAction(ctx: Context, verb: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    try {
      if (verb === 'merchant' || verb === 'callback') {
        await this.startPaymentFieldWizard(
          ctx,
          'gateway_edit',
          'admin_gateway_awaiting_field',
          verb,
          'gateway.default',
        );
        return;
      }
      if (verb === 'toggle') {
        const enabled = await this.settings.getValue<boolean>('gateway.default.enabled', true);
        await this.settings.upsert({
          key: 'gateway.default.enabled',
          value: String(!enabled),
          category: 'GATEWAY',
          type: 'BOOLEAN',
          isPublic: false,
        });
        await this.runtime.alert(ctx, '✅ ذخیره شد.');
      } else if (verb === 'sandbox') {
        const sandbox = await this.settings.getValue<boolean>(
          'gateway.default.sandbox',
          config.payments.online.sandbox,
        );
        await this.settings.upsert({
          key: 'gateway.default.sandbox',
          value: String(!sandbox),
          category: 'GATEWAY',
          type: 'BOOLEAN',
          isPublic: false,
        });
        await this.runtime.alert(ctx, '✅ ذخیره شد.');
      }
      await this.viewGateway(ctx);
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  async onPaymentWizardCancel(
    ctx: Context,
    section: 'cards' | 'crypto' | 'gateway',
  ): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    await this.runtime.clearState(telegramId);
    if (section === 'cards') await this.viewBankCards(ctx);
    else if (section === 'crypto') await this.viewCryptoWallets(ctx);
    else await this.viewGateway(ctx);
  }

  async onMandatoryJoinAction(ctx: Context, verb: string, index: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    try {
      if (verb === 'toggle') {
        const enabled = await this.settings.getValue<boolean>(
          'telegram.mandatoryJoin.enabled',
          false,
        );
        await this.settings.upsert({
          key: 'telegram.mandatoryJoin.enabled',
          value: String(!enabled),
          category: 'TELEGRAM',
          type: 'BOOLEAN',
          isPublic: false,
        });
      } else if (verb === 'add') {
        await this.runtime.setState(telegramId, 'admin_join_channel_awaiting_username', {
          adminWizard: 'join_channel_add',
        });
        await this.runtime.editOrSend(
          ctx,
          'نام کاربری عمومی کانال را با @ وارد کنید. ربات باید ادمین آن کانال باشد.\n\nمثال: @my_channel',
          this.backHomeKeyboard(locale),
        );
        return;
      } else if (verb === 'remove') {
        const channels = await this.getMandatoryJoinChannels();
        const position = Number(index);
        if (Number.isInteger(position) && channels[position]) channels.splice(position, 1);
        await this.saveMandatoryJoinChannels(channels);
      }
      await this.runtime.alert(ctx, '✅ ذخیره شد.');
      await this.viewMandatoryJoin(ctx);
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  async onReferralAction(ctx: Context, verb: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    try {
      if (verb === 'toggle') {
        const enabled = await this.settings.getValue<boolean>('referral.enabled', true);
        await this.settings.upsert({
          key: 'referral.enabled',
          value: String(!enabled),
          category: 'REFERRAL',
          type: 'BOOLEAN',
          isPublic: true,
        });
        await this.runtime.alert(ctx, '✅ ذخیره شد.');
        await this.viewReferrals(ctx);
        return;
      }
      const field = verb === 'gb' ? 'rewardTrafficGb' : 'rulesText';
      await this.runtime.setState(telegramId, 'admin_referral_awaiting_value', {
        adminWizard: 'referral_edit',
        adminField: field,
      });
      await this.runtime.editOrSend(
        ctx,
        field === 'rewardTrafficGb'
          ? 'حجم هدیه برای هر نفر را به گیگ وارد کنید (مثال: 1 یا 1.5):'
          : 'متن کامل قوانین رفرال را ارسال کنید:',
        this.backHomeKeyboard(locale),
      );
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  // ===========================================================================
  // Dashboard
  // ===========================================================================

  private async renderDashboard(ctx: Context, _refresh = false): Promise<void> {
    const validateUrl = (url: string): boolean => {
      try {
        const parsedUrl = new URL(url);
        return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
      } catch {
        return false;
      }
    };

    const handleDnsError = async (ctx: Context, error: any): Promise<void> => {
      const locale = await this.runtime.getLocale(this.getTelegramId(ctx) ?? '');
      const errorMessage = `❌ ${t(locale, 'admin.gateway.error')}: ${error.message}`;
      await this.runtime.editOrSend(ctx, errorMessage, this.backHomeKeyboard(locale));
    };
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const normalize = (s?: string) => (s ? s.trim().replace(/^\+/, '') : '');
    const isConfiguredSuperAdmin =
      normalize(config.superAdmin.telegramId) === normalize(telegramId);

    if (!isConfiguredSuperAdmin && !(await this.assertAdmin(ctx, locale))) return;
    await this.runtime.pushMenu(telegramId, 'admin');
    await this.runtime.setState(telegramId, 'idle');

    try {
      const stats = await this.admin.getDashboardStats();
      const msg =
        `⚙️ ${t(locale, 'admin.title')}\n\n` +
        `👥 ${t(locale, 'admin.users', { total: stats.users.total, active: stats.users.active })}\n` +
        `📡 ${t(locale, 'admin.subs', { total: stats.subscriptions.total, active: stats.subscriptions.active })}\n` +
        `🛒 ${t(locale, 'admin.orders', { total: stats.orders.total, pending: stats.orders.pending })}\n` +
        `💳 ${t(locale, 'admin.payments', { total: stats.payments.total, pending: stats.payments.pending })}\n` +
        `🎫 ${t(locale, 'admin.tickets', { total: stats.tickets.total, open: stats.tickets.open })}\n` +
        `🖥️ ${t(locale, 'admin.servers', { total: stats.servers.total, healthy: stats.servers.healthy })}\n\n` +
        `💰 ${t(locale, 'admin.revenue', {
          today: stats.revenue.today ?? '0',
          month: stats.revenue.thisMonth ?? '0',
        })} ${stats.revenue.currency}\n\n` +
        `${t(locale, 'admin.sections')}`;
      await this.runtime.editOrSend(ctx, msg, this.dashKeyboard(locale), {
        parseMode: 'Markdown',
      });
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  /** The main admin keyboard (no web links). */
  private dashKeyboard(locale: BotLocale) {
    const B = (k: string, a: string) => Markup.button.callback(t(locale, k), a);
    return Markup.inlineKeyboard([
      [B('admin.section.dashboard', 'adm:dash')],
      [B('admin.section.users', 'adm:users'), B('admin.section.payments', 'adm:pay')],
      [B('admin.section.cards', 'adm:cards'), B('admin.section.crypto', 'adm:crypto')],
      [B('admin.section.gateway', 'adm:gateway'), B('admin.section.wallet', 'adm:wallet')],
      [B('admin.section.plans', 'adm:plans'), B('admin.section.vouchers', 'adm:vouchers')],
      [B('admin.section.referral', 'adm:ref'), B('admin.section.trial', 'adm:trial')],
      [B('admin.section.broadcast', 'adm:broadcast'), B('admin.section.tickets', 'adm:tickets')],
      [B('admin.section.education', 'adm:edu'), B('admin.section.settings', 'adm:settings')],
      [Markup.button.callback('📢 عضویت اجباری', 'adm:join')],
      [B('admin.section.statistics', 'adm:stats'), B('admin.section.logs', 'adm:logs')],
      [B('admin.section.roles', 'adm:roles')],
      [B('menu.home', 'home')],
    ]);
  }

  private backHomeKeyboard(locale: BotLocale) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
        Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
      ],
    ]);
  }

  private async viewMandatoryJoin(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const [enabled, channels] = await Promise.all([
      this.settings.getValue<boolean>('telegram.mandatoryJoin.enabled', false),
      this.getMandatoryJoinChannels(),
    ]);
    const rows = channels.map((channel, index) => [
      Markup.button.url(`📢 ${channel.title}`, channel.url),
      Markup.button.callback('🗑 حذف', `ajoin:remove:${index}`),
    ]);
    await this.runtime.editOrSend(
      ctx,
      `📢 عضویت اجباری\n\nوضعیت: ${enabled ? '✅ فعال' : '⛔ غیرفعال'}\nکانال‌ها: ${channels.length}\n\nادمین‌ها از این بررسی معاف هستند.`,
      Markup.inlineKeyboard([
        ...rows,
        [Markup.button.callback('➕ افزودن کانال', 'ajoin:add')],
        [Markup.button.callback(enabled ? '⛔ غیرفعال‌سازی' : '✅ فعال‌سازی', 'ajoin:toggle')],
        [
          Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
          Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
        ],
      ]),
    );
  }

  private async getMandatoryJoinChannels(): Promise<MandatoryJoinChannel[]> {
    const value = await this.settings.getValue<unknown>('telegram.mandatoryJoin.channels', []);
    return Array.isArray(value) ? (value as MandatoryJoinChannel[]) : [];
  }

  private async saveMandatoryJoinChannels(channels: MandatoryJoinChannel[]): Promise<void> {
    await this.settings.upsert({
      key: 'telegram.mandatoryJoin.channels',
      value: JSON.stringify(channels),
      category: 'TELEGRAM',
      type: 'JSON',
      isPublic: false,
    });
  }

  // ===========================================================================
  // Section views
  // ===========================================================================

  /** USERS — list recent users with subscription + VPN panel usage. */
  private async viewUsers(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        publicId: true,
        telegramId: true,
        firstName: true,
        username: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    const lines: string[] = [];
    for (const u of users) {
      const name = u.username
        ? `@${u.username}`
        : [u.firstName, u.telegramId].filter(Boolean).join(' ');
      const r = u.role === 'SUPER_ADMIN' ? '👑' : u.role === 'ADMIN' ? '🛡️' : '👤';

      // Get active subscriptions with VPN usage
      // u.publicId is a UUID; we need the BigInt id for subscription lookup
      const userRecord = await this.prisma.user.findUnique({
        where: { publicId: u.publicId },
        select: { id: true },
      });
      const subs = userRecord
        ? await this.prisma.subscription.findMany({
            where: { userId: userRecord.id, status: { in: ['ACTIVE', 'TRIAL'] } },
            include: { plan: true, vpnUser: true },
          })
        : [];

      let vpnInfo = '   📭 No active plan';
      if (subs.length > 0) {
        const subLines: string[] = [];
        for (const sub of subs) {
          let usedGB = '0';
          let totalGB = '∞';
          let daysLeft = '∞';

          if (sub.vpnUser) {
            // Try to get fresh data from 3x-UI panel
            try {
              const panelUsage = await this.vpn.getUsageFromPanel(sub.id);
              if (panelUsage) {
                usedGB = (Number(panelUsage.usedBytes) / (1024 * 1024 * 1024)).toFixed(1);
                totalGB = panelUsage.totalBytes
                  ? (Number(panelUsage.totalBytes) / (1024 * 1024 * 1024)).toFixed(0)
                  : '∞';
                if (panelUsage.expiresAt) {
                  const diff = panelUsage.expiresAt.getTime() - Date.now();
                  daysLeft = diff > 0 ? `${Math.floor(diff / 86400000)}d` : 'expired';
                }
              } else {
                // Fall back to DB
                const used = BigInt(sub.usedTrafficBytes.toString());
                usedGB = (Number(used) / (1024 * 1024 * 1024)).toFixed(1);
                if (sub.trafficLimitBytes)
                  totalGB = (
                    Number(BigInt(sub.trafficLimitBytes.toString())) /
                    (1024 * 1024 * 1024)
                  ).toFixed(0);
                if (sub.expiresAt) {
                  const diff = sub.expiresAt.getTime() - Date.now();
                  daysLeft = diff > 0 ? `${Math.floor(diff / 86400000)}d` : 'expired';
                }
              }
            } catch {
              // Use DB fallback
              const used = BigInt(sub.usedTrafficBytes.toString());
              usedGB = (Number(used) / (1024 * 1024 * 1024)).toFixed(1);
              if (sub.trafficLimitBytes)
                totalGB = (
                  Number(BigInt(sub.trafficLimitBytes.toString())) /
                  (1024 * 1024 * 1024)
                ).toFixed(0);
              if (sub.expiresAt) {
                const diff = sub.expiresAt.getTime() - Date.now();
                daysLeft = diff > 0 ? `${Math.floor(diff / 86400000)}d` : 'expired';
              }
            }
          } else {
            // No VPN user yet
            const used = BigInt(sub.usedTrafficBytes.toString());
            usedGB = (Number(used) / (1024 * 1024 * 1024)).toFixed(1);
            if (sub.trafficLimitBytes)
              totalGB = (
                Number(BigInt(sub.trafficLimitBytes.toString())) /
                (1024 * 1024 * 1024)
              ).toFixed(0);
            if (sub.expiresAt) {
              const diff = sub.expiresAt.getTime() - Date.now();
              daysLeft = diff > 0 ? `${Math.floor(diff / 86400000)}d` : 'expired';
            }
          }

          subLines.push(`   📡 ${sub.plan.name}: ${usedGB}/${totalGB} GB · ${daysLeft} left`);
        }
        vpnInfo = subLines.join('\n');
      }

      lines.push(`${r} ${name}\n   ${u.role} · ${u.status}\n${vpnInfo}`);
    }
    const msg = `👥 مدیریت کاربران (${users.length}):\n\n${lines.join('\n\n') || '—'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  private async viewPayments(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;

    const [awaitingPayments, pendingCount] = await Promise.all([
      this.prisma.payment.findMany({
        where: { status: 'AWAITING_VERIFY' },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { user: true, receipt: true },
      }),
      this.prisma.payment.count({ where: { status: 'PENDING' } }),
    ]);

    // Forward receipt photos to admin
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    for (const p of awaitingPayments) {
      const rcpt = (p as any).receipt;
      if (rcpt?.fileKey) {
        try {
          const caption =
            `🧾 رسید #${p.publicId.slice(0, 8)}\n` +
            `👤 ${(p as any).user?.firstName ?? (p as any).user?.telegramId ?? '—'}\n` +
            `💰 ${p.amount ? String(p.amount) : '—'} ${p.currency ?? 'IRR'}`;
          await (ctx as any).telegram.sendPhoto(telegramId, await this.receiptUrl(rcpt.fileKey), {
            caption,
          });
        } catch {
          // Ignore forwarding errors
        }
      }
    }

    let msg = `💳 پرداخت‌ها\n\n`;
    msg += `📩 در انتظار تایید رسید: ${awaitingPayments.length}\n`;
    msg += `⏳ در انتظار پرداخت: ${pendingCount}\n`;

    const rows: any[][] = [];

    if (awaitingPayments.length > 0) {
      msg += `\n📩 رسیدهای در انتظار:\n`;
      for (const p of awaitingPayments) {
        const who = (p as any).user?.firstName ?? (p as any).user?.telegramId ?? '—';
        const hasReceipt = !!(p as any).receipt;
        msg += `\n• #${p.publicId.slice(0, 8)} · ${p.amount ? String(p.amount) : '—'} ${p.currency ?? 'IRR'}`;
        msg += `\n  👤 ${who} · ${hasReceipt ? '📎 رسید دارد' : '❌ بدون رسید'}`;
        rows.push([
          Markup.button.callback(`🔍 مدیریت #${p.publicId.slice(0, 8)}`, `paymanage:${p.publicId}`),
        ]);
      }
    } else {
      msg += `\n✅ رسید در انتظاری نیست.`;
    }

    rows.push([
      Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
      Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
    ]);
    await this.runtime.editOrSend(ctx, msg, Markup.inlineKeyboard(rows));
  }

  /** Show payment/receipt detail with approve/reject buttons */
  async showPaymentManage(ctx: Context, paymentPublicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;

    const payment = await this.prisma.payment.findUnique({
      where: { publicId: paymentPublicId },
      include: { user: true, receipt: true },
    });
    if (!payment) {
      await this.runtime.editOrSend(ctx, '❌ پرداخت یافت نشد.', this.backHomeKeyboard(locale));
      return;
    }

    const rcpt = (payment as any).receipt;

    // Forward receipt photo if available
    if (rcpt?.fileKey) {
      try {
        await (ctx as any).telegram.sendPhoto(ctx.from?.id, await this.receiptUrl(rcpt.fileKey), {
          caption: `🧾 رسید پرداخت #${paymentPublicId.slice(0, 8)}`,
        });
      } catch {
        /* ignore */
      }
    }

    const msg =
      `🧾 رسید #${paymentPublicId.slice(0, 8)}\n\n` +
      `👤 کاربر: ${(payment as any).user?.firstName ?? (payment as any).user?.telegramId ?? '—'}\n` +
      `💰 مبلغ: ${payment.amount ? String(payment.amount) : '—'} ${payment.currency ?? 'IRR'}\n` +
      `📋 روش: ${payment.method ?? '—'}\n` +
      `📊 وضعیت: ${payment.status}\n` +
      `📎 رسید: ${rcpt ? '✅ دارد' : '❌ ندارد'}\n` +
      `📅 ${payment.createdAt.toLocaleDateString('fa-IR')}\n`;

    const rows: any[][] = [];
    if (payment.status === 'AWAITING_VERIFY' && rcpt) {
      rows.push([
        Markup.button.callback('✅ تایید و شارژ', `payapprove:${paymentPublicId}`),
        Markup.button.callback('❌ رد رسید', `payreject:${paymentPublicId}`),
      ]);
    }
    rows.push([
      Markup.button.callback(`◀️ بازگشت`, 'adm:pay'),
      Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
    ]);
    await this.runtime.editOrSend(ctx, msg, Markup.inlineKeyboard(rows));
  }

  private receiptUrl(fileKey: string): Promise<string> | string {
    if (fileKey.startsWith('AgAC') || fileKey.startsWith('http')) return fileKey;
    return this.storage.getSignedUrl(fileKey);
  }

  /** Route Telegram receipt approval through PaymentsService. */
  async approveReceipt(ctx: Context, paymentPublicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.verifyReceipt(ctx, paymentPublicId, 'APPROVED');
  }

  /** Route Telegram receipt rejection through PaymentsService. */
  async rejectReceipt(ctx: Context, paymentPublicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.verifyReceipt(ctx, paymentPublicId, 'REJECTED');
  }

  private async verifyReceipt(
    ctx: Context,
    paymentPublicId: string,
    status: 'APPROVED' | 'REJECTED',
  ): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const session = await this.runtime.getSession(telegramId);
    const payment = await this.prisma.payment.findUnique({
      where: { publicId: paymentPublicId },
      include: { receipt: true },
    });
    if (!session.userId || !payment?.receipt) {
      await (ctx as any).telegram
        .sendMessage(telegramId, '❌ پرداخت یافت نشد یا قبلاً بررسی شده.')
        .catch(() => {});
      return;
    }

    await this.payments.verifyReceipt({
      adminId: session.userId,
      receiptPublicId: payment.receipt.publicId,
      status,
    });
    const action = status === 'APPROVED' ? 'تایید' : 'رد';
    await (ctx as any).telegram
      .sendMessage(
        telegramId,
        `${status === 'APPROVED' ? '✅' : '❌'} رسید #${paymentPublicId.slice(0, 8)} ${action} شد.`,
      )
      .catch(() => {});
  }

  /** BANK CARDS — list admin-managed cards. */
  private async viewBankCards(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const { data: cards, meta } = await this.bankCards.listAll({ pageSize: 20 });
    const lines = cards.map((c) => {
      const star = c.isDefault ? '⭐ ' : '';
      const st = c.isActive ? '✅' : '⛔';
      return `${star}${st} ${maskCardNumber(c.cardNumber)}\n   ${c.cardHolder} · ${c.bankName}`;
    });
    const empty =
      locale === 'fa'
        ? 'هنوز کارتی ثبت نشده است. از دکمه افزودن استفاده کنید.'
        : 'No cards yet. Use Add card to create one.';
    const msg = `🏦 ${locale === 'fa' ? 'کارت‌های بانکی' : 'Bank cards'} (${meta.total}):\n\n${lines.join('\n\n') || empty}`;
    const rows: any[][] = cards.map((c) => [
      Markup.button.callback(
        `${c.isDefault ? '⭐ ' : ''}${c.isActive ? '✅' : '⛔'} ${c.cardNumber.slice(-4)}`,
        `acard:detail:${c.publicId}`,
      ),
    ]);
    rows.push([
      Markup.button.callback(`➕ ${locale === 'fa' ? 'افزودن کارت' : 'Add card'}`, 'acard:new:0'),
    ]);
    rows.push([
      Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
      Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
    ]);
    await this.runtime.editOrSend(ctx, msg, Markup.inlineKeyboard(rows));
  }

  private async viewBankCardDetail(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const card = await this.bankCards.findOne(publicId);
    const msg =
      `🏦 ${card.label ?? card.bankName}\n\n` +
      `${locale === 'fa' ? 'شماره کارت' : 'Card'}: ${maskCardNumber(card.cardNumber)}\n` +
      `${locale === 'fa' ? 'صاحب حساب' : 'Holder'}: ${card.cardHolder}\n` +
      `${locale === 'fa' ? 'بانک' : 'Bank'}: ${card.bankName}\n` +
      `${locale === 'fa' ? 'شبا' : 'IBAN'}: ${card.shebaNumber ? this.maskValue(card.shebaNumber) : '—'}\n` +
      `${locale === 'fa' ? 'وضعیت' : 'Status'}: ${card.isActive ? '✅' : '⛔'}${card.isDefault ? ' ⭐' : ''}`;
    const rows = [
      [
        Markup.button.callback(card.isActive ? '⏸ غیرفعال' : '▶️ فعال', `acard:toggle:${publicId}`),
        Markup.button.callback('⭐ پیش‌فرض', `acard:default:${publicId}`),
      ],
      [
        Markup.button.callback('✏️ شماره', `acardedit:number:${publicId}`),
        Markup.button.callback('✏️ صاحب حساب', `acardedit:holder:${publicId}`),
      ],
      [
        Markup.button.callback('✏️ بانک', `acardedit:bank:${publicId}`),
        Markup.button.callback('✏️ شبا', `acardedit:sheba:${publicId}`),
      ],
      [Markup.button.callback('✏️ برچسب', `acardedit:label:${publicId}`)],
      [Markup.button.callback('🗑 حذف امن', `acard:confirmDelete:${publicId}`)],
      [
        Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:cards'),
        Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
      ],
    ];
    await this.runtime.editOrSend(ctx, msg, Markup.inlineKeyboard(rows));
  }

  private async confirmCardDelete(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const card = await this.bankCards.findOne(publicId);
    await this.runtime.editOrSend(
      ctx,
      `${locale === 'fa' ? 'کارت غیرفعال شود؟ سوابق پرداخت حفظ می‌شود.' : 'Disable this card? Payment history is preserved.'}\n${maskCardNumber(card.cardNumber)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ تأیید', `acard:delete:${publicId}`)],
        [
          Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, `acard:detail:${publicId}`),
          Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
        ],
      ]),
    );
  }

  private async startCardCreate(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    await this.runtime.setState(telegramId, 'admin_card_awaiting_field', {
      adminWizard: 'card_create',
      adminField: 'number',
      adminDraft: {},
    });
    await this.renderPaymentPrompt(ctx, locale, 'شماره ۱۶ رقمی کارت را وارد کنید:', 'cards');
  }

  /** WALLET OPS — recent wallet transactions + balances overview. */
  private async viewWalletOps(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const [totalBalance, recent] = await Promise.all([
      this.prisma.wallet.aggregate({ _sum: { balance: true } }),
      this.prisma.walletTransaction.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    const total = fromMinor(totalBalance._sum.balance ?? 0n);
    const creditTypes = new Set([
      'DEPOSIT',
      'BONUS',
      'CASHBACK',
      'REFERRAL_REWARD',
      'GIFT',
      'REFUND',
      'VOUCHER_REDEEM',
    ]);
    const lines = recent.map((tx) => {
      const sign = creditTypes.has(tx.type as string) ? '➕' : '➖';
      return `${sign} ${fromMinor(tx.amount)} · ${tx.type}\n   ${tx.description ?? ''}`;
    });
    const msg = `💰 کیف پول\n\nمجموع موجودی کاربران: ${total}\n\nآخرین تراکنش‌ها:\n${lines.join('\n\n') || '—'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** PLANS — list subscription plans with inline detail buttons (spec #8/#9). */
  private async viewPlans(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const plans = await this.prisma.plan.findMany({
      where: { status: { not: 'ARCHIVED' } },
      orderBy: [{ priority: 'desc' }, { price: 'asc' }],
      take: 20,
    });
    const msg =
      `📋 مدیریت بسته‌ها (${plans.length}):\n\n` +
      (plans
        .map((p) => {
          const st = p.isEnabled ? '✅' : '⛔';
          const price = fromMinor(p.price);
          const traffic = p.trafficLimitGb ? `${p.trafficLimitGb}GB` : 'نامحدود';
          return `${st} ${p.name}\n   ${price} ${p.currency} · ${p.durationDays ?? 0} روز · ${traffic}`;
        })
        .join('\n\n') || '—');
    await this.runtime.editOrSend(ctx, msg, this.plansListKeyboard(plans, locale));
  }

  /** Inline keyboard for the plans list: one detail button per plan + ➕ new. */
  private plansListKeyboard(plans: any[], locale: BotLocale) {
    const rows = plans.map((p) => [
      Markup.button.callback(
        `${p.isEnabled ? '✅' : '⛔'} ${p.name} · ${fromMinor(p.price)} ${p.currency}`,
        `aplan:detail:${p.publicId}`,
      ),
    ]);
    rows.push([Markup.button.callback(`➕ ${t(locale, 'admin.plan.new')}`, 'aplan:new:0')]);
    rows.push([
      Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
      Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
    ]);
    return Markup.inlineKeyboard(rows);
  }

  /** PLAN DETAIL — show one plan and offer edit/toggle/archive (spec #8/#9). */
  private async viewPlanDetail(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const plan = await this.plans.getRaw(publicId);
    const price = plan.price.toString();
    const orig = plan.originalPrice ? plan.originalPrice.toString() : null;
    const eligibleInboundCount = await this.vpn
      .selectProvisioningTarget(plan as never)
      .then((target) => target.inboundIds.length)
      .catch(() => 0);
    const msg =
      `📋 ${plan.name}\n\n` +
      `🆔 ${plan.slug}\n` +
      `💰 قیمت: ${price} ${plan.currency}${orig ? ` (بدون تخفیف ${orig})` : ''}\n` +
      `📊 حجم: ${plan.trafficLimitGb ? `${plan.trafficLimitGb} GB` : 'نامحدود'}\n` +
      `📅 مدت: ${plan.durationDays ?? 0} روز\n` +
      `📱 دستگاه‌ها: ${plan.deviceLimit} · سرورها: ${plan.serverLimit}\n` +
      `🔄 تمدید: ${plan.isRenewable ? 'بله' : 'خیر'}\n` +
      `⚡ اولویت: ${plan.priority} · وضعیت: ${plan.isEnabled ? 'فعال' : 'غیرفعال'}\n` +
      `XUI ALL_ACTIVE: ${eligibleInboundCount}`;
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback(`✏️ ویرایش`, `aplan:edit:${publicId}`),
        Markup.button.callback(plan.isEnabled ? '⛔ مخفی' : '✅ نمایش', `aplan:toggle:${publicId}`),
      ],
      [Markup.button.callback(`🗑️ آرشیو`, `aplan:archive:${publicId}`)],
      [
        Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:plans'),
        Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
      ],
    ]);
    await this.runtime.editOrSend(ctx, msg, kb);
  }

  /** Toggle a plan's visibility and re-render the detail view. */
  private async togglePlanVisibility(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const plan = await this.plans.getRaw(publicId);
    // Use isVisible (the field PlansService.update exposes); isEnabled tracks
    // purchase-eligibility and is mirrored here so the toggle feels atomic.
    await this.plans.update(publicId, {
      isVisible: !plan.isVisible,
      isEnabled: !plan.isEnabled,
    });
    await this.viewPlanDetail(ctx, publicId);
  }

  /** Archive (soft-delete) a plan and return to the list. */
  private async archivePlan(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.plans.remove(publicId);
    await this.viewPlans(ctx);
  }

  /** Start the create-plan wizard: ask for the plan name. */
  private async startPlanWizard(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    await this.runtime.setState(telegramId, 'admin_plan_awaiting_field', {
      adminWizard: 'plan_create',
      adminField: 'name',
      adminDraft: {},
    });
    await this.runtime.pushMenu(telegramId, 'admin_plans');
    const msg =
      `➕ ساخت بسته جدید (۱/۴)\n\n` +
      `نام بسته را وارد کنید:\n` +
      `(مثال: یک‌ماهه ویژه)\n\n` +
      `❌ برای لغو /cancel را بفرستید.`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** Start editing an existing plan: show a field picker. */
  private async startPlanEdit(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    await this.runtime.setState(telegramId, 'admin_plan_awaiting_field', {
      adminWizard: 'plan_edit',
      adminTargetId: publicId,
      adminField: '',
      adminDraft: {},
    });
    await this.runtime.pushMenu(telegramId, 'admin_plan_detail');
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('📝 نام', `apledit:name:${publicId}`)],
      [Markup.button.callback('💰 قیمت', `apledit:price:${publicId}`)],
      [Markup.button.callback('📅 مدت (روز)', `apledit:durationDays:${publicId}`)],
      [Markup.button.callback('📊 حجم (GB)', `apledit:trafficLimitGb:${publicId}`)],
      [Markup.button.callback('📱 سقف دستگاه', `apledit:deviceLimit:${publicId}`)],
      [Markup.button.callback('⚡ اولویت', `apledit:priority:${publicId}`)],
      [Markup.button.callback('📝 توضیحات', `apledit:description:${publicId}`)],
      [
        Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, `aplan:detail:${publicId}`),
        Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
      ],
    ]);
    await this.runtime.editOrSend(ctx, `✏️ ویرایش بسته\n\nکدام فیلد را تغییر می‌دهید؟`, kb);
  }

  /** Pick a specific field to edit on a plan and ask for its new value. */
  private async startPlanEditField(ctx: Context, publicId: string, field: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const plan = await this.plans.getRaw(publicId);
    const current =
      field === 'price'
        ? plan.price.toString()
        : field === 'trafficLimitGb'
          ? (plan.trafficLimitGb?.toString() ?? 'نامحدود')
          : ((plan as any)[field] ?? '—');
    await this.runtime.setState(telegramId, 'admin_plan_awaiting_field', {
      adminWizard: 'plan_edit',
      adminTargetId: publicId,
      adminField: field,
      adminDraft: {},
    });
    const labels: Record<string, string> = {
      name: 'نام',
      price: 'قیمت (به تومان یا دلار)',
      durationDays: 'مدت به روز',
      trafficLimitGb: 'حجم به گیگابایت (0 = نامحدود)',
      deviceLimit: 'سقف تعداد دستگاه',
      priority: 'اولویت (عدد بزرگ‌تر = بالاتر)',
      description: 'توضیحات',
    };
    const msg =
      `✏️ ویرایش «${labels[field] ?? field}»\n\n` +
      `مقدار فعلی: ${current}\n\n` +
      `مقدار جدید را وارد کنید:`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** VOUCHERS — recent voucher codes. */
  private async viewVouchers(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const result = await this.vouchers.listAll({ page: 1, limit: 10 });
    const lines = result.data.map((v) => {
      const st = v.isActive && v.redemptions < v.maxRedemptions ? '🟢' : '⛔';
      return `${st} ${v.code}\n   ${v.planName ?? v.type} · ${v.redemptions}/${v.maxRedemptions} استفاده`;
    });
    const msg = `🎟 کدهای ووچر (${result.meta.total}):\n\n${lines.join('\n\n') || '—'}`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('➕ ساخت ووچر', 'avoucher:new')],
      [
        Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
        Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
      ],
    ]);
    await this.runtime.editOrSend(ctx, msg, kb);
  }

  private async startVoucherWizard(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const plans = await this.prisma.plan.findMany({
      where: { isEnabled: true, status: { not: 'ARCHIVED' } },
      orderBy: [{ priority: 'desc' }, { price: 'asc' }],
      take: 30,
    });
    const rows: any[][] = plans.map((plan) => [
      Markup.button.callback(
        `${plan.name} · ${fromMinor(plan.price)} ${plan.currency}`,
        `avoucher:plan:${plan.publicId}`,
      ),
    ]);
    rows.push([
      Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:vouchers'),
      Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
    ]);
    const msg = plans.length
      ? '🎟 ساخت ووچر\n\nپلنی که با کد فعال می‌شود را انتخاب کنید:'
      : '⛔ هیچ پلن فعالی برای ساخت ووچر وجود ندارد.';
    await this.runtime.editOrSend(ctx, msg, Markup.inlineKeyboard(rows));
  }

  private async selectVoucherPlan(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const plan = await this.prisma.plan.findUnique({ where: { publicId } });
    if (!plan || !plan.isEnabled || plan.status === 'ARCHIVED') {
      await this.startVoucherWizard(ctx);
      return;
    }
    await this.runtime.setState(telegramId, 'admin_voucher_awaiting_uses', {
      adminWizard: 'voucher_create',
      adminField: 'maxRedemptions',
      adminDraft: { planId: plan.id.toString(), planName: plan.name },
    });
    await this.runtime.editOrSend(
      ctx,
      `🎟 پلن: ${plan.name}\n\nتعداد کل دفعات قابل مصرف کد را وارد کنید (۱ برای یک‌بارمصرف):`,
      this.backHomeKeyboard(locale),
    );
  }

  /** REFERRALS — canonical traffic reward settings and usage. */
  private async viewReferrals(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const [enabled, rewardGb, rules, total, rewarded] = await Promise.all([
      this.settings.getValue<boolean>('referral.enabled', true),
      this.settings.getValue<number>('referral.rewardTrafficGb', 1),
      this.settings.getValue<string>(
        'referral.rulesText',
        'هر کاربر جدید پس از عضویت در کانال‌ها و شروع ربات، برای خودش و معرفش هدیه حجم دریافت می‌کند.',
      ),
      this.prisma.referralLog.count({ where: { rewardType: 'TRAFFIC' } }),
      this.prisma.referralLog.count({ where: { rewardType: 'TRAFFIC', status: 'REWARDED' } }),
    ]);
    const msg =
      `👥 سیستم معرفی\n\n` +
      `وضعیت: ${enabled ? '✅ فعال' : '⛔ غیرفعال'}\n` +
      `هدیه هر نفر: ${rewardGb} گیگ\n` +
      `دعوت‌های موفق: ${rewarded} از ${total}\n\n` +
      `📜 قوانین فعلی:\n${rules}`;
    await this.runtime.editOrSend(
      ctx,
      msg,
      Markup.inlineKeyboard([
        [Markup.button.callback(enabled ? '⛔ غیرفعال‌سازی' : '✅ فعال‌سازی', 'aref:toggle')],
        [Markup.button.callback('✏️ ویرایش حجم هدیه', 'aref:gb')],
        [Markup.button.callback('📝 ویرایش قوانین', 'aref:rules')],
        [
          Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
          Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
        ],
      ]),
    );
  }

  /** TRIAL SETTINGS — show current trial config from DB settings. */
  private async viewTrialSettings(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const [traffic, days, limit] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: 'trial.traffic_limit_mb' } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'trial.duration_days' } }),
      this.prisma.systemSetting.findUnique({ where: { key: 'trial.limit_per_account' } }),
    ]);
    const msg =
      `🎁 تنظیمات اشتراک آزمایشی\n\n` +
      `📊 حجم: ${traffic?.value ?? '500'} MB\n` +
      `📅 مدت: ${days?.value ?? '3'} روز\n` +
      `🔒 سقف هر کاربر: ${limit?.value ?? '1'} بار`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** CRYPTO WALLETS — list admin-managed deposit addresses. */
  private async viewCryptoWallets(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const { data: wallets, meta } = await this.cryptoWallets.listAll({ pageSize: 20 });
    const lines = wallets.map((w) => {
      const star = w.isDefault ? '⭐ ' : '';
      const st = w.isActive ? '✅' : '⛔';
      return `${star}${st} ${w.currency}\n   ${w.address}\n   شبکه: ${w.network ?? '—'}`;
    });
    const empty =
      locale === 'fa'
        ? 'هنوز مقصد رمزارزی ثبت نشده است. از دکمه افزودن استفاده کنید.'
        : 'No crypto destinations yet. Use Add destination.';
    const rows: any[][] = wallets.map((w) => [
      Markup.button.callback(
        `${w.isDefault ? '⭐ ' : ''}${w.isActive ? '✅' : '⛔'} ${w.currency} · ${w.network ?? '—'}`,
        `acrypto:detail:${w.publicId}`,
      ),
    ]);
    rows.push([
      Markup.button.callback(
        `➕ ${locale === 'fa' ? 'افزودن مقصد' : 'Add destination'}`,
        'acrypto:new:0',
      ),
    ]);
    rows.push([
      Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
      Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
    ]);
    const msg = `₿ ${locale === 'fa' ? 'مقصدهای رمزارز' : 'Crypto destinations'} (${meta.total}):\n\n${lines.join('\n\n') || empty}`;
    await this.runtime.editOrSend(ctx, msg, Markup.inlineKeyboard(rows));
  }

  private async viewCryptoWalletDetail(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const wallet = await this.cryptoWallets.findOne(publicId);
    const msg =
      `₿ ${wallet.currency}${wallet.label ? ` · ${wallet.label}` : ''}\n\n` +
      `${locale === 'fa' ? 'آدرس' : 'Address'}: ${wallet.address}\n` +
      `${locale === 'fa' ? 'شبکه' : 'Network'}: ${wallet.network ?? '—'}\n` +
      `${locale === 'fa' ? 'راهنما' : 'Instructions'}: ${wallet.instructions ?? '—'}\n` +
      `${locale === 'fa' ? 'وضعیت' : 'Status'}: ${wallet.isActive ? '✅' : '⛔'}${wallet.isDefault ? ' ⭐' : ''}`;
    const rows = [
      [
        Markup.button.callback(
          wallet.isActive ? '⏸ غیرفعال' : '▶️ فعال',
          `acrypto:toggle:${publicId}`,
        ),
        Markup.button.callback('⭐ پیش‌فرض', `acrypto:default:${publicId}`),
      ],
      [
        Markup.button.callback('✏️ آدرس', `acryptoedit:address:${publicId}`),
        Markup.button.callback('✏️ شبکه', `acryptoedit:network:${publicId}`),
      ],
      [
        Markup.button.callback('✏️ برچسب', `acryptoedit:label:${publicId}`),
        Markup.button.callback('✏️ راهنما', `acryptoedit:instructions:${publicId}`),
      ],
      [Markup.button.callback('🗑 حذف', `acrypto:confirmDelete:${publicId}`)],
      [
        Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:crypto'),
        Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
      ],
    ];
    await this.runtime.editOrSend(ctx, msg, Markup.inlineKeyboard(rows));
  }

  private async chooseCryptoCurrency(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const currencies: CryptoCurrency[] = ['USDT_TRC20', 'USDT_ERC20', 'TON', 'BTC', 'ETH'];
    const rows: any[][] = currencies.map((currency) => [
      Markup.button.callback(currency, `acrypto:choose:${currency}`),
    ]);
    rows.push([
      Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:crypto'),
      Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
    ]);
    await this.runtime.editOrSend(
      ctx,
      locale === 'fa' ? 'ارز و شبکه را انتخاب کنید:' : 'Choose currency and network:',
      Markup.inlineKeyboard(rows),
    );
  }

  private async startCryptoCreate(ctx: Context, currency: CryptoCurrency): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    await this.runtime.setState(telegramId, 'admin_crypto_awaiting_field', {
      adminWizard: 'crypto_create',
      adminField: 'address',
      adminDraft: { currency },
    });
    await this.renderPaymentPrompt(ctx, locale, 'آدرس مقصد را وارد کنید:', 'crypto');
  }

  private async confirmCryptoDelete(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const wallet = await this.cryptoWallets.findOne(publicId);
    await this.runtime.editOrSend(
      ctx,
      `${locale === 'fa' ? 'این مقصد حذف شود؟' : 'Delete this destination?'}\n${wallet.currency} · ${wallet.address}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ تأیید حذف', `acrypto:delete:${publicId}`)],
        [
          Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, `acrypto:detail:${publicId}`),
          Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
        ],
      ]),
    );
  }

  /** GATEWAY — online payment gateway status. */
  private async viewGateway(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const [enabled, merchantId, sandbox, callbackUrl] = await Promise.all([
      this.settings.getValue<boolean>('gateway.default.enabled', true),
      this.settings.getValue<string>('gateway.default.merchantId', ''),
      this.settings.getValue<boolean>('gateway.default.sandbox', config.payments.online.sandbox),
      this.settings.getValue<string>('gateway.default.callbackUrl', ''),
    ]);
    const effectiveMerchantId = merchantId.trim() || config.payments.online.merchantId;
    const effectiveCallbackUrl = callbackUrl.trim() || config.payments.online.callbackUrl;
    const msg =
      `🔌 ${locale === 'fa' ? 'درگاه پرداخت آنلاین' : 'Online gateway'} · Zarinpal\n\n` +
      `${locale === 'fa' ? 'وضعیت' : 'Status'}: ${enabled ? '✅' : '⛔'}\n` +
      `${locale === 'fa' ? 'شناسه پذیرنده' : 'Merchant ID'}: ${effectiveMerchantId ? this.maskValue(effectiveMerchantId) : '⚠️ تنظیم نشده'}\n` +
      `${locale === 'fa' ? 'حالت آزمایشی' : 'Sandbox'}: ${sandbox ? '✅' : '⛔'}\n` +
      `${locale === 'fa' ? 'نشانی بازگشت' : 'Callback URL'}: ${effectiveCallbackUrl ? '✅ تنظیم شده' : 'پیش‌فرض سامانه'}\n\n` +
      `${locale === 'fa' ? 'کلید API یا رمز جداگانه‌ای در پیاده‌سازی فعلی زرین‌پال مصرف نمی‌شود.' : 'The current Zarinpal provider does not consume a separate API key or secret.'}`;
    const rows = [
      [Markup.button.callback(enabled ? '⏸ غیرفعال' : '▶️ فعال', 'agw:toggle')],
      [Markup.button.callback('✏️ شناسه پذیرنده', 'agw:merchant')],
      [Markup.button.callback('✏️ نشانی بازگشت', 'agw:callback')],
      [Markup.button.callback(sandbox ? '🌐 حالت واقعی' : '🧪 حالت آزمایشی', 'agw:sandbox')],
      [
        Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
        Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
      ],
    ];
    await this.runtime.editOrSend(ctx, msg, Markup.inlineKeyboard(rows));
  }

  /** BROADCAST — send a message to all active users. */
  private async viewBroadcast(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const total = await this.prisma.user.count({ where: { status: 'ACTIVE' } });
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    await this.runtime.setState(telegramId, 'admin_broadcast_awaiting_message');
    const msg =
      `📣 پیام همگانی\n\n` +
      `👥 کاربران فعال: ${total}\n\n` +
      `پیام مورد نظرتان را بنویسید تا برای همه ارسال شود:\n` +
      `❌ برای لغو /cancel را بفرستید.`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** Handle broadcast message text input — sent to admin confirmation. */
  async onBroadcastText(ctx: Context, text: string): Promise<boolean> {
    const locale = await this.guard(ctx);
    if (!locale) return false;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return false;
    const session = await this.runtime.getSession(telegramId);
    if (session.state !== 'admin_broadcast_awaiting_message') return false;

    if (text.trim() === '/cancel') {
      await this.runtime.clearState(telegramId);
      await this.runtime.editOrSend(ctx, '❌ عملیات لغو شد.', this.backHomeKeyboard(locale));
      return true;
    }

    const total = await this.prisma.user.count({ where: { status: 'ACTIVE' } });
    await this.runtime.setState(telegramId, 'admin_broadcast_confirm', { broadcastMessage: text });
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback(`✅ ارسال (${total} نفر)`, 'bcast:confirm'),
        Markup.button.callback('❌ لغو', 'bcast:cancel'),
      ],
    ]);
    await this.runtime.editOrSend(
      ctx,
      `📣 پیام شما:\n\n${text}\n\n👥 ارسال به ${total} کاربر فعال؟`,
      kb,
    );
    return true;
  }

  /** Execute the broadcast — send message to all active users. */
  async onBroadcastConfirm(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const session = await this.runtime.getSession(telegramId);
    if (session.state !== 'admin_broadcast_confirm') return;
    const message = session.data?.broadcastMessage;
    if (!message) {
      await this.runtime.clearState(telegramId);
      await this.runtime.editOrSend(ctx, '❌ پیام یافت نشد.', this.backHomeKeyboard(locale));
      return;
    }

    await this.runtime.clearState(telegramId);
    await this.runtime.alert(ctx, '⏳ در حال ارسال...');

    const result = await this.broadcast.sendToAllActiveUsers(message as string, telegramId);

    const msg =
      `✅ ارسال شد!\n\n` +
      `📨 موفق: ${result.sent}\n` +
      `❌ ناموفق: ${result.failed}\n` +
      `👥 کل: ${result.total}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** Cancel broadcast — clear state and return to admin. */
  async onBroadcastCancel(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    await this.runtime.clearState(telegramId);
    await this.runtime.editOrSend(ctx, '❌ ارسال همگانی لغو شد.', this.backHomeKeyboard(locale));
  }

  /** TICKETS — open support tickets. */
  private async viewTickets(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const tickets = await this.prisma.ticket.findMany({
      where: { status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: 12,
      include: { user: true },
    });
    const lines = tickets.map((tk) => {
      const name = tk.user?.firstName ?? tk.user?.telegramId ?? '—';
      return `🎫 ${tk.subject}\n   ${name} · ${tk.category}`;
    });
    const msg = `🎫 تیکت‌های باز (${tickets.length}):\n\n${lines.join('\n\n') || '✅ تیکتی باز نیست'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** EDUCATION — list education articles. */
  private async viewEducation(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const articles = await this.prisma.educationArticle.findMany({
      where: { isVisible: true },
      orderBy: { createdAt: 'desc' },
      take: 12,
    });
    const lines = articles.map((a) => `📚 ${a.title}\n   ${a.slug}`);
    const msg = `📚 آموزش‌ها (${articles.length}):\n\n${lines.join('\n\n') || '—'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** SETTINGS — list editable settings with inline edit buttons (spec #9/#10). */
  private async viewSettings(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const settings = await this.settings.listAll();
    const editable = settings.filter((s) => s.editable).slice(0, 25);
    const msg =
      `⚙️ مدیریت تنظیمات (${editable.length}):\n\n` +
      (editable
        .map((s) => `• ${s.key}: ${this.settingDisplayValue(s)}${s.isPublic ? ' 👁️' : ''}`)
        .join('\n') || '—');
    const rows = editable
      .slice(0, 12)
      .map((s) => [
        Markup.button.callback(`✏️ ${s.key}`, `aset:edit:${encodeURIComponent(s.key)}`),
      ]);
    rows.push([Markup.button.callback(`➕ ${t(locale, 'admin.setting.new')}`, 'aset:new:0')]);
    rows.push([
      Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
      Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
    ]);
    await this.runtime.editOrSend(ctx, msg, Markup.inlineKeyboard(rows));
  }

  /** Start editing an existing setting: ask for the new value. */
  private async startSettingEdit(ctx: Context, key: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const decodedKey = decodeURIComponent(key);
    const setting = await this.settings.get(decodedKey);
    const telegramId = ctx.from && ctx.from.id ? ctx.from.id.toString() : null;
    if (!telegramId) return;
    await this.runtime.setState(telegramId, 'admin_setting_awaiting_value', {
      adminWizard: 'setting_edit',
      adminTargetId: decodedKey,
      adminField: 'value',
      adminDraft: {
        category: setting.category,
        type: setting.type,
        isPublic: setting.isPublic,
        description: setting.description,
      },
    });
    await this.runtime.pushMenu(telegramId, 'admin_settings');
    const msg =
      `✏️ ویرایش تنظیم\n\n` +
      `کلید: ${decodedKey}\n` +
      `نوع: ${setting.type}\n` +
      `مقدار فعلی: ${this.settingDisplayValue(setting)}\n\n` +
      `مقدار جدید را وارد کنید:`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** Start creating a new setting: ask for the key. */
  private async startSettingCreate(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = ctx.from && ctx.from.id ? ctx.from.id.toString() : null;
    if (!telegramId) return;
    await this.runtime.setState(telegramId, 'admin_setting_awaiting_value', {
      adminWizard: 'setting_edit',
      adminField: 'key',
      adminDraft: {},
    });
    await this.runtime.pushMenu(telegramId, 'admin_settings');
    const msg =
      `➕ ساخت تنظیم جدید\n\n` +
      `کلید تنظیم را وارد کنید:\n` +
      `(مثال: trial.duration_days)\n\n` +
      `❌ برای لغو /cancel را بفرستید.`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** Toggle a boolean setting between 'true' and 'false'. */
  private async toggleSetting(ctx: Context, key: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const decodedKey = decodeURIComponent(key);
    const current = await this.settings.get(decodedKey);
    const next = current.value === 'true' ? 'false' : 'true';
    await this.settings.upsert({
      key: decodedKey,
      value: next,
      category: current.category,
      type: current.type,
      isPublic: current.isPublic,
      editable: current.editable,
      description: current.description ?? undefined,
    });
    await this.viewSettings(ctx);
  }

  /** Delete a setting (if editable) and return to the list. */
  private async deleteSetting(ctx: Context, key: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const decodedKey = decodeURIComponent(key);
    await this.settings.remove(decodedKey);
    await this.viewSettings(ctx);
  }

  /** STATISTICS — extended stats. */
  private async viewStatistics(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const stats = await this.admin.getDashboardStats();
    const msg =
      `📈 آمار تفصیلی\n\n` +
      `👥 کاربران: ${stats.users.total} (جدید امروز: ${stats.users.newToday}، ماه: ${stats.users.newThisMonth})\n` +
      `📡 اشتراک‌ها: ${stats.subscriptions.total}\n` +
      `🛒 سفارش‌ها: ${stats.orders.total}\n` +
      `💳 پرداخت‌ها: ${stats.payments.total}\n\n` +
      `💰 درآمد:\n` +
      `   امروز: ${stats.revenue.today} ${stats.revenue.currency}\n` +
      `   ماه: ${stats.revenue.thisMonth} ${stats.revenue.currency}\n` +
      `   کل: ${stats.revenue.total} ${stats.revenue.currency}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** AUDIT LOGS — recent audit entries. */
  private async viewAuditLogs(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const logs = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 12,
      include: { user: true },
    });
    const lines = logs.map((l) => {
      const name = l.user?.firstName ?? l.user?.telegramId ?? 'سیستم';
      return `📝 ${l.action} · ${l.resource}\n   ${name}`;
    });
    const msg = `📝 لاگ‌های ممیزی (${logs.length}):\n\n${lines.join('\n\n') || '—'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** ROLES — list users with elevated roles. */
  private async viewRoles(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const admins = await this.prisma.user.findMany({
      where: { role: { in: ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'] } },
      orderBy: { role: 'asc' },
      take: 20,
    });
    const lines = admins.map((u) => {
      const r = u.role === 'SUPER_ADMIN' ? '👑' : u.role === 'ADMIN' ? '🛡️' : '🔧';
      return `${r} ${u.firstName ?? u.telegramId}\n   ${u.role}`;
    });
    const msg = `🔐 نقش‌ها و دسترسی‌ها (${admins.length}):\n\n${lines.join('\n\n') || '—'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  // -------------------------------------------------------------------------
  // CRUD wizard text handlers - invoked by telegram-bot.service.ts onText
  // when the session state is one of admin_*_awaiting_*. Each handler reads
  // the wizard kind + field from the session, accumulates the draft, and on
  // the final step calls the relevant domain service.
  // -------------------------------------------------------------------------

  /**
   * Entry point for admin wizard text input. Returns true if the message was
   * consumed by a wizard (so the caller can short-circuit normal text handling).
   * Handles /cancel to abort any active wizard.
   */
  async onWizardText(ctx: Context, text: string): Promise<boolean> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return false;
    const locale = await this.guard(ctx);
    if (!locale) return false;
    const session = await this.runtime.getSession(telegramId);
    const state = session.state;

    if (text.trim() === '/cancel') {
      if (
        state === 'admin_plan_awaiting_field' ||
        state === 'admin_voucher_awaiting_uses' ||
        state === 'admin_setting_awaiting_value' ||
        state === 'admin_card_awaiting_field' ||
        state === 'admin_crypto_awaiting_field' ||
        state === 'admin_gateway_awaiting_field' ||
        state === 'admin_referral_awaiting_value' ||
        state === 'admin_join_channel_awaiting_username'
      ) {
        await this.runtime.clearState(telegramId);
        await this.runtime.editOrSend(ctx, '❌ عملیات لغو شد.', this.backHomeKeyboard(locale));
        return true;
      }
    }

    if (state === 'admin_plan_awaiting_field') {
      await this.handlePlanWizardText(ctx, text);
      return true;
    }
    if (state === 'admin_voucher_awaiting_uses') {
      await this.handleVoucherWizardText(ctx, text);
      return true;
    }
    if (state === 'admin_setting_awaiting_value') {
      await this.handleSettingWizardText(ctx, text);
      return true;
    }
    if (state === 'admin_card_awaiting_field') {
      await this.handleCardWizardText(ctx, text);
      return true;
    }
    if (state === 'admin_crypto_awaiting_field') {
      await this.handleCryptoWizardText(ctx, text);
      return true;
    }
    if (state === 'admin_gateway_awaiting_field') {
      await this.handleGatewayWizardText(ctx, text);
      return true;
    }
    if (state === 'admin_referral_awaiting_value') {
      await this.handleReferralWizardText(ctx, text);
      return true;
    }
    if (state === 'admin_join_channel_awaiting_username') {
      await this.handleMandatoryJoinChannelText(ctx, text);
      return true;
    }
    return false;
  }

  private async handleVoucherWizardText(ctx: Context, text: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const draft = session.data?.adminDraft ?? {};
    const maxRedemptions = Number(text.trim());
    if (
      !Number.isSafeInteger(maxRedemptions) ||
      maxRedemptions < 1 ||
      maxRedemptions > 2_147_483_647
    ) {
      await this.runtime.editOrSend(
        ctx,
        '❌ تعداد مصرف باید یک عدد صحیح بزرگ‌تر از صفر باشد:',
        this.backHomeKeyboard(locale),
      );
      return;
    }
    try {
      const [voucher] = await this.vouchers.generate(
        { planId: BigInt(String(draft.planId)), maxRedemptions },
        await this.requireAdminUserId(ctx),
      );
      await this.runtime.clearState(telegramId);
      await this.runtime.editOrSend(
        ctx,
        `✅ ووچر ساخته شد\n\nکد: \`${voucher.code}\`\nپلن: ${String(draft.planName)}\nسقف مصرف: ${voucher.maxRedemptions}\nهر کاربر: فقط یک‌بار`,
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ ساخت ووچر دیگر', 'avoucher:new')],
          [
            Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:vouchers'),
            Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
          ],
        ]),
        { parseMode: 'Markdown' },
      );
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  private async startPaymentFieldWizard(
    ctx: Context,
    wizard: 'card_edit' | 'crypto_edit' | 'gateway_edit',
    state: BotState,
    field: string,
    targetId: string,
  ): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.setState(telegramId, state, {
      adminWizard: wizard,
      adminTargetId: targetId,
      adminField: field,
      adminDraft: {},
    });
    const prompts: Record<string, string> = {
      number: 'شماره جدید کارت را وارد کنید:',
      holder: 'نام جدید صاحب حساب را وارد کنید:',
      bank: 'نام جدید بانک را وارد کنید:',
      sheba: 'شماره شبای جدید را وارد کنید؛ برای حذف /clear را بفرستید:',
      label: 'برچسب جدید را وارد کنید؛ برای حذف /clear را بفرستید:',
      address: 'آدرس مقصد جدید را وارد کنید:',
      network: 'شبکه جدید را وارد کنید؛ برای حذف /clear را بفرستید:',
      instructions: 'راهنمای جدید را وارد کنید؛ برای حذف /clear را بفرستید:',
      merchant: 'شناسه پذیرنده جدید را وارد کنید. مقدار ذخیره‌شده دوباره نمایش داده نمی‌شود:',
      callback: 'نشانی HTTPS بازگشت را وارد کنید؛ برای استفاده از پیش‌فرض /default را بفرستید:',
    };
    await this.renderPaymentPrompt(
      ctx,
      locale,
      prompts[field] ?? 'مقدار جدید را وارد کنید:',
      state === 'admin_card_awaiting_field'
        ? 'cards'
        : state === 'admin_crypto_awaiting_field'
          ? 'crypto'
          : 'gateway',
    );
  }

  private async handleCardWizardText(ctx: Context, text: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const data = session.data ?? {};
    const field = String(data.adminField ?? '');
    const draft = { ...(data.adminDraft ?? {}) };
    const value = text.trim();
    try {
      if (data.adminWizard === 'card_edit') {
        const fields: Record<string, string> = {
          number: 'cardNumber',
          holder: 'cardHolder',
          bank: 'bankName',
          sheba: 'shebaNumber',
          label: 'label',
        };
        const key = fields[field];
        if (!key) return;
        await this.bankCards.update(
          String(data.adminTargetId),
          { [key]: value === '/clear' ? null : value } as any,
          await this.requireAdminUserId(ctx),
        );
        await this.runtime.clearState(telegramId);
        await this.runtime.alert(ctx, '✅ ذخیره شد.');
        await this.viewBankCardDetail(ctx, String(data.adminTargetId));
        return;
      }

      if (field === 'number') {
        draft.cardNumber = value;
        await this.advancePaymentWizard(
          telegramId,
          'admin_card_awaiting_field',
          'card_create',
          'holder',
          draft,
        );
        await this.renderPaymentPrompt(ctx, locale, 'نام صاحب حساب را وارد کنید:', 'cards');
      } else if (field === 'holder') {
        draft.cardHolder = value;
        await this.advancePaymentWizard(
          telegramId,
          'admin_card_awaiting_field',
          'card_create',
          'bank',
          draft,
        );
        await this.renderPaymentPrompt(ctx, locale, 'نام بانک را وارد کنید:', 'cards');
      } else if (field === 'bank') {
        draft.bankName = value;
        await this.advancePaymentWizard(
          telegramId,
          'admin_card_awaiting_field',
          'card_create',
          'sheba',
          draft,
        );
        await this.renderPaymentPrompt(
          ctx,
          locale,
          'شماره شبا را وارد کنید یا /skip بفرستید:',
          'cards',
        );
      } else if (field === 'sheba') {
        if (value !== '/skip') draft.shebaNumber = value;
        await this.advancePaymentWizard(
          telegramId,
          'admin_card_awaiting_field',
          'card_create',
          'label',
          draft,
        );
        await this.renderPaymentPrompt(
          ctx,
          locale,
          'برچسب را وارد کنید یا /skip بفرستید:',
          'cards',
        );
      } else if (field === 'label') {
        if (value !== '/skip') draft.label = value;
        const created = await this.bankCards.create(
          draft as any,
          await this.requireAdminUserId(ctx),
        );
        await this.runtime.clearState(telegramId);
        await this.runtime.alert(ctx, '✅ کارت افزوده شد.');
        await this.viewBankCardDetail(ctx, created.publicId);
      }
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.paymentPromptKeyboard(locale, 'cards'),
      );
    }
  }

  private async handleCryptoWizardText(ctx: Context, text: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const data = session.data ?? {};
    const field = String(data.adminField ?? '');
    const draft = { ...(data.adminDraft ?? {}) };
    const value = text.trim();
    try {
      if (data.adminWizard === 'crypto_edit') {
        const nullable = ['network', 'label', 'instructions'].includes(field);
        await this.cryptoWallets.update(
          String(data.adminTargetId),
          { [field]: nullable && value === '/clear' ? null : value } as any,
          await this.requireAdminUserId(ctx),
        );
        await this.runtime.clearState(telegramId);
        await this.runtime.alert(ctx, '✅ ذخیره شد.');
        await this.viewCryptoWalletDetail(ctx, String(data.adminTargetId));
        return;
      }

      if (field === 'address') {
        draft.address = value;
        await this.advancePaymentWizard(
          telegramId,
          'admin_crypto_awaiting_field',
          'crypto_create',
          'network',
          draft,
        );
        await this.renderPaymentPrompt(
          ctx,
          locale,
          'شبکه را وارد کنید یا /skip بفرستید:',
          'crypto',
        );
      } else if (field === 'network') {
        if (value !== '/skip') draft.network = value;
        await this.advancePaymentWizard(
          telegramId,
          'admin_crypto_awaiting_field',
          'crypto_create',
          'label',
          draft,
        );
        await this.renderPaymentPrompt(
          ctx,
          locale,
          'برچسب را وارد کنید یا /skip بفرستید:',
          'crypto',
        );
      } else if (field === 'label') {
        if (value !== '/skip') draft.label = value;
        await this.advancePaymentWizard(
          telegramId,
          'admin_crypto_awaiting_field',
          'crypto_create',
          'instructions',
          draft,
        );
        await this.renderPaymentPrompt(
          ctx,
          locale,
          'راهنمای پرداخت را وارد کنید یا /skip بفرستید:',
          'crypto',
        );
      } else if (field === 'instructions') {
        if (value !== '/skip') draft.instructions = value;
        const created = await this.cryptoWallets.create(
          draft as any,
          await this.requireAdminUserId(ctx),
        );
        await this.runtime.clearState(telegramId);
        await this.runtime.alert(ctx, '✅ مقصد رمزارز افزوده شد.');
        await this.viewCryptoWalletDetail(ctx, created.publicId);
      }
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.paymentPromptKeyboard(locale, 'crypto'),
      );
    }
  }

  private async handleGatewayWizardText(ctx: Context, text: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const field = String(session.data?.adminField ?? '');
    const value = text.trim();
    try {
      if (field === 'merchant' && !value) throw new Error('Merchant ID is required');
      if (field === 'callback' && value !== '/default') {
        const url = new URL(value);
        if (url.protocol !== 'https:') throw new Error('Callback URL must use HTTPS');
      }
      await this.settings.upsert({
        key: field === 'merchant' ? 'gateway.default.merchantId' : 'gateway.default.callbackUrl',
        value: value === '/default' ? '' : value,
        category: 'GATEWAY',
        type: 'STRING',
        isPublic: false,
      });
      await this.runtime.clearState(telegramId);
      await this.runtime.alert(ctx, '✅ پیکربندی ذخیره شد.');
      await this.viewGateway(ctx);
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.paymentPromptKeyboard(locale, 'gateway'),
      );
    }
  }

  private async handleReferralWizardText(ctx: Context, text: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const field = String(session.data?.adminField ?? '');
    const value = text.trim();
    try {
      if (field === 'rewardTrafficGb') {
        const gigabytes = Number(value.replace(',', '.'));
        if (!Number.isFinite(gigabytes) || gigabytes < 0.1 || gigabytes > 1000) {
          throw new Error('حجم هدیه باید عددی بین ۰.۱ تا ۱۰۰۰ گیگ باشد.');
        }
        await this.settings.upsert({
          key: 'referral.rewardTrafficGb',
          value: String(gigabytes),
          category: 'REFERRAL',
          type: 'NUMBER',
          isPublic: true,
          description: 'Traffic reward in GB for both referral participants',
        });
      } else if (field === 'rulesText') {
        if (!value || value.length > 3000) {
          throw new Error('متن قوانین باید بین ۱ تا ۳۰۰۰ نویسه باشد.');
        }
        await this.settings.upsert({
          key: 'referral.rulesText',
          value,
          category: 'REFERRAL',
          type: 'STRING',
          isPublic: true,
          description: 'Admin-authored referral rules shown in Telegram',
        });
      } else {
        throw new Error('ویرایش رفرال معتبر نیست.');
      }
      await this.runtime.clearState(telegramId);
      await this.runtime.alert(ctx, '✅ تنظیمات رفرال ذخیره شد.');
      await this.viewReferrals(ctx);
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  private async handleMandatoryJoinChannelText(ctx: Context, text: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    try {
      const username = text.trim();
      if (!/^@[A-Za-z0-9_]{5,}$/.test(username)) throw new Error('نام کاربری کانال معتبر نیست.');
      const chat: any = await ctx.telegram.getChat(username);
      if (chat.type !== 'channel' || !chat.username)
        throw new Error('این نام کاربری متعلق به یک کانال عمومی نیست.');
      const bot = await ctx.telegram.getMe();
      const membership = await ctx.telegram.getChatMember(chat.id, bot.id);
      if (!['creator', 'administrator'].includes(membership.status)) {
        throw new Error('ابتدا ربات را ادمین کانال کنید.');
      }
      const channels = await this.getMandatoryJoinChannels();
      const channel: MandatoryJoinChannel = {
        chatId: String(chat.id),
        title: chat.title || `@${chat.username}`,
        url: `https://t.me/${chat.username}`,
      };
      const existing = channels.findIndex((item) => item.chatId === channel.chatId);
      if (existing >= 0) channels[existing] = channel;
      else channels.push(channel);
      await this.saveMandatoryJoinChannels(channels);
      await this.runtime.clearState(telegramId);
      await this.runtime.alert(ctx, '✅ کانال ذخیره شد.');
      await this.viewMandatoryJoin(ctx);
    } catch (err: any) {
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  private async advancePaymentWizard(
    telegramId: string,
    state: BotState,
    wizard: 'card_create' | 'crypto_create',
    field: string,
    draft: Record<string, unknown>,
  ): Promise<void> {
    await this.runtime.setState(telegramId, state, {
      adminWizard: wizard,
      adminField: field,
      adminDraft: draft,
    });
  }

  // ---- Plan wizard (create + edit-field) ----

  private async handlePlanWizardText(ctx: Context, text: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const data = session.data ?? {};
    const wizard = data.adminWizard as 'plan_create' | 'plan_edit';
    const field = (data.adminField as string) ?? 'name';
    const draft = (data.adminDraft as Record<string, unknown>) ?? {};

    try {
      if (wizard === 'plan_create') {
        await this.handlePlanCreateStep(ctx, locale, telegramId, field, draft, text);
      } else {
        await this.handlePlanEditStep(
          ctx,
          locale,
          telegramId,
          data.adminTargetId as string,
          field,
          text,
        );
      }
    } catch (err: any) {
      await this.runtime.clearState(telegramId);
      await this.runtime.editOrSend(
        ctx,
        this.runtime.translateError(locale, err),
        this.backHomeKeyboard(locale),
      );
    }
  }

  /** Multi-step create wizard: name -> price -> durationDays -> trafficLimitGb -> done. */
  private async handlePlanCreateStep(
    ctx: Context,
    locale: BotLocale,
    telegramId: string,
    field: string,
    draft: Record<string, unknown>,
    text: string,
  ): Promise<void> {
    const value = text.trim();
    if (field === 'name') {
      draft.name = value;
      await this.runtime.setState(telegramId, 'admin_plan_awaiting_field', {
        adminWizard: 'plan_create',
        adminField: 'price',
        adminDraft: draft,
      });
      await this.runtime.editOrSend(
        ctx,
        `➕ ساخت بسته (۲/۴)\n\nنام: ${value}\n\nقیمت را وارد کنید (عدد اعشاری، مثال 9.99):`,
        this.backHomeKeyboard(locale),
      );
      return;
    }
    if (field === 'price') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        await this.runtime.editOrSend(
          ctx,
          '❌ قیمت نامعتبر است. عدد وارد کنید:',
          this.backHomeKeyboard(locale),
        );
        return;
      }
      draft.price = value;
      await this.runtime.setState(telegramId, 'admin_plan_awaiting_field', {
        adminWizard: 'plan_create',
        adminField: 'durationDays',
        adminDraft: draft,
      });
      await this.runtime.editOrSend(
        ctx,
        `➕ ساخت بسته (۳/۴)\n\nمدت اشتراک به روز را وارد کنید (مثال 30):`,
        this.backHomeKeyboard(locale),
      );
      return;
    }
    if (field === 'durationDays') {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) {
        await this.runtime.editOrSend(
          ctx,
          '❌ مدت نامعتبر است. عدد روز وارد کنید:',
          this.backHomeKeyboard(locale),
        );
        return;
      }
      draft.durationDays = n;
      await this.runtime.setState(telegramId, 'admin_plan_awaiting_field', {
        adminWizard: 'plan_create',
        adminField: 'trafficLimitGb',
        adminDraft: draft,
      });
      await this.runtime.editOrSend(
        ctx,
        `➕ ساخت بسته (۴/۴)\n\nحجم ترافیک به گیگابایت را وارد کنید (0 یا خالی = نامحدود):`,
        this.backHomeKeyboard(locale),
      );
      return;
    }
    if (field === 'trafficLimitGb') {
      const gb = value === '' || value === '0' ? null : parseInt(value, 10);
      draft.trafficLimitGb = gb;
      const created = await this.plans.create({
        name: draft.name as string,
        price: draft.price as string,
        durationDays: draft.durationDays as number,
        trafficLimitGb: gb,
        type: 'TRAFFIC',
        currency: 'IRT',
        isVisible: true,
        isRenewable: true,
      });
      await this.runtime.clearState(telegramId);
      // created.price is already a formatted string from PlanDto (e.g. "2.00")
      const msg =
        `✅ بسته ساخته شد!\n\n` +
        `🆔 ${created.publicId.slice(0, 8)}\n` +
        `📦 ${created.name}\n` +
        `💰 ${created.price} ${created.currency}\n` +
        `📅 ${created.durationDays ?? 0} روز`;
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('👁️ مشاهده', `aplan:detail:${created.publicId}`)],
        [
          Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:plans'),
          Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
        ],
      ]);
      await this.runtime.editOrSend(ctx, msg, kb);
    }
  }

  /** Single-step edit: apply the new value to one field of an existing plan. */
  private async handlePlanEditStep(
    ctx: Context,
    locale: BotLocale,
    telegramId: string,
    publicId: string,
    field: string,
    text: string,
  ): Promise<void> {
    const value = text.trim();
    const update: Record<string, unknown> = {};
    if (field === 'price') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        await this.runtime.editOrSend(
          ctx,
          '❌ قیمت نامعتبر. عدد وارد کنید:',
          this.backHomeKeyboard(locale),
        );
        return;
      }
      update.price = value;
    } else if (field === 'trafficLimitGb') {
      update.trafficLimitGb = value === '' || value === '0' ? null : parseInt(value, 10);
    } else if (field === 'durationDays' || field === 'deviceLimit' || field === 'priority') {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0) {
        await this.runtime.editOrSend(
          ctx,
          '❌ عدد نامعتبر. عدد صحیح وارد کنید:',
          this.backHomeKeyboard(locale),
        );
        return;
      }
      update[field] = n;
    } else {
      // name, description, etc.
      update[field] = value;
    }
    await this.plans.update(publicId, update);
    await this.runtime.clearState(telegramId);
    const plan = await this.plans.getRaw(publicId);
    const msg = `✅ به‌روزرسانی شد.\n\n${field}: ${update[field] ?? '(پاک شد)'}\n\n📦 ${plan.name}`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('👁️ مشاهده', `aplan:detail:${publicId}`)],
      [
        Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:plans'),
        Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
      ],
    ]);
    await this.runtime.editOrSend(ctx, msg, kb);
  }

  // ---- Setting wizard (edit value + create new key) ----

  private async handleSettingWizardText(ctx: Context, text: string): Promise<void> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    const data = session.data ?? {};
    const field = (data.adminField as string) ?? 'value';
    const draft = (data.adminDraft as Record<string, unknown>) ?? {};
    const value = text.trim();

    if (field === 'key') {
      // Creating a new setting: now ask for its value.
      draft.key = value;
      await this.runtime.setState(telegramId, 'admin_setting_awaiting_value', {
        adminWizard: 'setting_edit',
        adminField: 'value',
        adminTargetId: value,
        adminDraft: draft,
      });
      await this.runtime.editOrSend(
        ctx,
        `➕ ساخت تنظیم (۲/۲)\n\nکلید: ${value}\n\nمقدار را وارد کنید:`,
        this.backHomeKeyboard(locale),
      );
      return;
    }

    // field === 'value' — persist
    const key = data.adminTargetId as string;
    await this.settings.upsert({
      key,
      value,
      category: (draft.category as string) ?? 'GENERAL',
      type: (draft.type as string) ?? 'STRING',
      isPublic: (draft.isPublic as boolean) ?? false,
      editable: true,
      description: (draft.description as string) ?? undefined,
    });
    await this.runtime.clearState(telegramId);
    await this.runtime.editOrSend(
      ctx,
      `✅ ذخیره شد.\n\n${key} = ${value}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:settings')],
        [Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home')],
      ]),
    );
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private maskValue(value: string): string {
    if (value.length <= 4) return '••••';
    return `${'•'.repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
  }

  private settingDisplayValue(setting: {
    key: string;
    value: string;
    category: string;
    isPublic: boolean;
  }): string {
    const sensitive =
      setting.category === 'GATEWAY' ||
      /(secret|api.?key|password|token|credential|merchant|callback)/i.test(setting.key);
    return sensitive ? (setting.value ? this.maskValue(setting.value) : '—') : setting.value;
  }

  private paymentPromptKeyboard(locale: BotLocale, section: 'cards' | 'crypto' | 'gateway') {
    return Markup.inlineKeyboard([
      [Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, `apm:cancel:${section}`)],
      [Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home')],
    ]);
  }

  private async renderPaymentPrompt(
    ctx: Context,
    locale: BotLocale,
    prompt: string,
    section: 'cards' | 'crypto' | 'gateway',
  ): Promise<void> {
    await this.runtime.editOrSend(
      ctx,
      `${prompt}\n\n${locale === 'fa' ? 'برای لغو /cancel را بفرستید.' : 'Send /cancel to abort.'}`,
      this.paymentPromptKeyboard(locale, section),
    );
  }

  private async getAdminUserId(ctx: Context): Promise<bigint | null> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return null;
    return (await this.runtime.getSession(telegramId)).userId ?? null;
  }

  private async requireAdminUserId(ctx: Context): Promise<bigint> {
    const adminId = await this.getAdminUserId(ctx);
    if (!adminId) throw new Error('Admin user session is required');
    return adminId;
  }

  /** Verify admin role; return locale if OK (renders access-denied + null if not). */
  private async guard(ctx: Context): Promise<BotLocale | null> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) return null;
    const locale = await this.runtime.getLocale(telegramId);
    if (!(await this.assertAdmin(ctx, locale))) return null;
    return locale;
  }

  /** Verify the caller is an admin; show access-denied + return false if not. */
  private async assertAdmin(ctx: Context, locale: BotLocale): Promise<boolean> {
    const telegramId = this.getTelegramId(ctx);
    if (!telegramId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return false;
    }
    const session = await this.runtime.getSession(telegramId);
    const normalize = (s?: string) => (s ? s.trim().replace(/^\+/, '') : '');
    const isConfiguredSuperAdmin =
      normalize(config.superAdmin.telegramId) === normalize(telegramId);

    if (isConfiguredSuperAdmin) {
      return true;
    }

    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return false;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { role: true, telegramId: true },
    });

    const isDbConfiguredSuperAdmin =
      normalize(user?.telegramId ?? undefined) === normalize(config.superAdmin.telegramId);
    const role = isDbConfiguredSuperAdmin ? 'SUPER_ADMIN' : user?.role;

    if (role !== 'SUPER_ADMIN' && role !== 'ADMIN' && role !== 'OPERATOR') {
      await this.runtime.editOrSend(
        ctx,
        t(locale, 'admin.access.denied'),
        this.backHomeKeyboard(locale),
      );
      return false;
    }
    return true;
  }
}
