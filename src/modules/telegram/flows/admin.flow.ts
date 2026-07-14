import { Injectable, Logger } from '@nestjs/common';
import { Markup, type Context } from 'telegraf';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import type { BotLocale } from '../telegram.types';
import { AdminService } from '../../admin/admin.service';
import { fromMinor } from '@/common/utils/money.util';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BankCardsService } from '../../payments/bank-cards.service';
import { CryptoWalletsService } from '../../payments/crypto-wallets.service';
import { VouchersService } from '../../payments/vouchers.service';
import { PlansService } from '../../plans/plans.service';
import { SettingsService } from '../../settings/settings.service';
import { PanelsService } from '../../panels/panels.service';
import { BroadcastService } from '../../notifications/broadcast.service';
import { VpnService } from '../../vpn/vpn.service';
import { config } from '@/config';

/**
 * AdminFlow (spec #9, #10) — fully in-bot admin panel.
 *
 * Every interaction EDITS THE CURRENT MESSAGE IN PLACE (spec #7 UX): no new
 * messages are sent on button taps. All ~20 management sections render real
 * inline list/detail views — no dead web links. Role is re-checked on every
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
    private readonly panels: PanelsService,
    private readonly broadcast: BroadcastService,
    private readonly vpn: VpnService,
  ) {}

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
      servers: this.viewServers,
      panels: this.viewPanels,
      trial: this.viewTrialSettings,
      crypto: this.viewCryptoWallets,
      gateway: this.viewGateway,
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
  // CRUD action dispatchers — invoked by aps:*/aplan:*/aset:*/apnl:* handlers
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
      await this.runtime.editOrSend(ctx, this.runtime.translateError(locale, err), this.backHomeKeyboard(locale));
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
      await this.runtime.editOrSend(ctx, this.runtime.translateError(locale, err), this.backHomeKeyboard(locale));
    }
  }

  /** Dispatch a `apnl:<verb>:<id>` panel-management action. */
  async onPanelAction(ctx: Context, verb: string, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.runtime.alert(ctx);
    try {
      switch (verb) {
        case 'detail':
          await this.viewPanelDetail(ctx, publicId);
          break;
        case 'health':
          await this.checkPanelHealth(ctx, publicId);
          break;
        case 'toggle':
          await this.togglePanel(ctx, publicId);
          break;
        case 'new':
          await this.startPanelWizard(ctx);
          break;
        default:
          await this.viewPanels(ctx);
      }
    } catch (err: any) {
      await this.runtime.editOrSend(ctx, this.runtime.translateError(locale, err), this.backHomeKeyboard(locale));
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
      const locale = await this.runtime.getLocale(ctx.from?.id?.toString()!);
      const errorMessage = `❌ ${t(locale, 'admin.gateway.error')}: ${error.message}`;
      await this.runtime.editOrSend(ctx, errorMessage, this.backHomeKeyboard(locale));
    };
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const normalize = (s?: string) => (s ? s.trim().replace(/^\+/, '') : '');
    const isConfiguredSuperAdmin = normalize(config.superAdmin.telegramId) === normalize(telegramId);

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
      await this.runtime.editOrSend(ctx, this.runtime.translateError(locale, err), this.backHomeKeyboard(locale));
    }
  }

  /** The main admin keyboard with ~20 sections (no web links). */
  private dashKeyboard(locale: BotLocale) {
    const B = (k: string, a: string) => Markup.button.callback(t(locale, k), a);
    return Markup.inlineKeyboard([
      [B('admin.section.dashboard', 'adm:dash')],
      [B('admin.section.users', 'adm:users'), B('admin.section.payments', 'adm:pay')],
      [B('admin.section.cards', 'adm:cards'), B('admin.section.wallet', 'adm:wallet')],
      [B('admin.section.plans', 'adm:plans'), B('admin.section.vouchers', 'adm:vouchers')],
      [B('admin.section.referral', 'adm:ref'), B('admin.section.servers', 'adm:servers')],
      [B('admin.section.panels', 'adm:panels'), B('admin.section.trial', 'adm:trial')],
      [B('admin.section.crypto', 'adm:crypto'), B('admin.section.gateway', 'adm:gateway')],
      [B('admin.section.broadcast', 'adm:broadcast'), B('admin.section.tickets', 'adm:tickets')],
      [B('admin.section.education', 'adm:edu'), B('admin.section.settings', 'adm:settings')],
      [B('admin.section.statistics', 'adm:stats'), B('admin.section.logs', 'adm:logs')],
      [B('admin.section.roles', 'adm:roles')],
      [B('menu.home', 'home')],
    ]);
  }

  private backHomeKeyboard(locale: BotLocale) {
    return Markup.inlineKeyboard([
      [Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'), Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home')],
    ]);
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
      select: { publicId: true, telegramId: true, firstName: true, username: true, role: true, status: true, createdAt: true },
    });

    const lines: string[] = [];
    for (const u of users) {
      const name = u.username ? `@${u.username}` : [u.firstName, u.telegramId].filter(Boolean).join(' ');
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
                totalGB = panelUsage.totalBytes ? (Number(panelUsage.totalBytes) / (1024 * 1024 * 1024)).toFixed(0) : '∞';
                if (panelUsage.expiresAt) {
                  const diff = panelUsage.expiresAt.getTime() - Date.now();
                  daysLeft = diff > 0 ? `${Math.floor(diff / 86400000)}d` : 'expired';
                }
              } else {
                // Fall back to DB
                const used = BigInt(sub.usedTrafficBytes.toString());
                usedGB = (Number(used) / (1024 * 1024 * 1024)).toFixed(1);
                if (sub.trafficLimitBytes) totalGB = (Number(BigInt(sub.trafficLimitBytes.toString())) / (1024 * 1024 * 1024)).toFixed(0);
                if (sub.expiresAt) {
                  const diff = sub.expiresAt.getTime() - Date.now();
                  daysLeft = diff > 0 ? `${Math.floor(diff / 86400000)}d` : 'expired';
                }
              }
            } catch {
              // Use DB fallback
              const used = BigInt(sub.usedTrafficBytes.toString());
              usedGB = (Number(used) / (1024 * 1024 * 1024)).toFixed(1);
              if (sub.trafficLimitBytes) totalGB = (Number(BigInt(sub.trafficLimitBytes.toString())) / (1024 * 1024 * 1024)).toFixed(0);
              if (sub.expiresAt) {
                const diff = sub.expiresAt.getTime() - Date.now();
                daysLeft = diff > 0 ? `${Math.floor(diff / 86400000)}d` : 'expired';
              }
            }
          } else {
            // No VPN user yet
            const used = BigInt(sub.usedTrafficBytes.toString());
            usedGB = (Number(used) / (1024 * 1024 * 1024)).toFixed(1);
            if (sub.trafficLimitBytes) totalGB = (Number(BigInt(sub.trafficLimitBytes.toString())) / (1024 * 1024 * 1024)).toFixed(0);
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
    const telegramId = ctx.from?.id?.toString()!;
    for (const p of awaitingPayments) {
      const rcpt = (p as any).receipt;
      if (rcpt?.fileKey) {
        try {
          const caption =
            `🧾 رسید #${p.publicId.slice(0, 8)}\n` +
            `👤 ${(p as any).user?.firstName ?? (p as any).user?.telegramId ?? '—'}\n` +
            `💰 ${p.amount ? String(p.amount) : '—'} ${p.currency ?? 'IRR'}`;
          if (rcpt.fileKey.startsWith('AgAC') || rcpt.fileKey.startsWith('http')) {
            await (ctx as any).telegram.sendPhoto(telegramId, rcpt.fileKey, { caption });
          }
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
        rows.push([Markup.button.callback(`🔍 مدیریت #${p.publicId.slice(0, 8)}`, `paymanage:${p.publicId}`)]);
      }
    } else {
      msg += `\n✅ رسید در انتظاری نیست.`;
    }

    rows.push([Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'), Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home')]);
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
        if (rcpt.fileKey.startsWith('AgAC') || rcpt.fileKey.startsWith('http')) {
          await (ctx as any).telegram.sendPhoto(ctx.from?.id, rcpt.fileKey, {
            caption: `🧾 رسید پرداخت #${paymentPublicId.slice(0, 8)}`,
          });
        }
      } catch { /* ignore */ }
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
    rows.push([Markup.button.callback(`◀️ بازگشت`, 'adm:pay'), Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home')]);
    await this.runtime.editOrSend(ctx, msg, Markup.inlineKeyboard(rows));
  }

  /** Approve receipt and top up wallet */
  async approveReceipt(ctx: Context, paymentPublicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;

    const payment = await this.prisma.payment.findUnique({
      where: { publicId: paymentPublicId },
      include: { user: true, receipt: true },
    });
    if (!payment || payment.status !== 'AWAITING_VERIFY') {
      // Use sendMessage since the callback may come from a photo message
      try {
        await (ctx as any).telegram.sendMessage(ctx.from?.id!, '❌ پرداخت یافت نشد یا قبلاً تایید شده.');
      } catch { /* ignore */ }
      return;
    }

    const amount = payment.amount ?? 0n;
    const rcpt = (payment as any).receipt;
    const user = (payment as any).user;

    // Credit the user's wallet
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'CONFIRMED' } });
        if (rcpt) await tx.receipt.update({ where: { id: rcpt.id }, data: { status: 'APPROVED' } });
        // Credit wallet
        if (user?.id) {
          const wallet = await tx.wallet.findFirst({ where: { userId: user.id } });
          if (wallet) {
            await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: amount } } });
          }
        }
      });
    } catch {
      // Fallback: just mark confirmed
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'CONFIRMED' } });
    }

    const adminTelegramId = ctx.from?.id!;
    try {
      await (ctx as any).telegram.sendMessage(adminTelegramId,
        `✅ پرداخت #${paymentPublicId.slice(0, 8)} تایید شد.\n💰 مبلغ ${fromMinor(amount)} ${payment.currency ?? 'IRR'} به کیف پول کاربر اضافه شد.`,
      );
    } catch { /* ignore */ }

    // If this payment is for an ORDER, complete the order and provision the subscription
    let orderCompleted = false;
    let subscriptionInfo = '';
    if (payment.orderId && user?.id) {
      try {
        const order = await this.prisma.order.findUnique({
          where: { id: payment.orderId },
          include: { plan: true },
        });
        if (order && order.status === 'PENDING') {
          // Mark order as completed
          await this.prisma.order.update({
            where: { id: order.id },
            data: { status: 'COMPLETED', completedAt: new Date() },
          });
          // Create subscription
          const plan = order.plan;
          if (plan) {
            const trafficLimitBytes = plan.trafficLimitGb ? BigInt(plan.trafficLimitGb) * 1024n * 1024n * 1024n : null;
            const expiresAt = plan.durationDays
              ? new Date(Date.now() + plan.durationDays * 24 * 3600 * 1000)
              : null;
            const sub = await this.prisma.subscription.create({
              data: {
                publicId: crypto.randomUUID(),
                userId: user.id,
                planId: plan.id,
                orderId: order.id,
                status: 'ACTIVE',
                type: plan.type,
                trafficLimitBytes,
                usedTrafficBytes: 0n,
                durationDays: plan.durationDays,
                startsAt: new Date(),
                expiresAt,
                deviceLimit: plan.deviceLimit,
                isTrial: plan.isTrial,
              },
              include: { plan: true },
            });
            orderCompleted = true;
            subscriptionInfo = `\n\n🎉 اشتراک فعال شد!\n📦 پلن: ${plan.name}\n📅 مدت: ${plan.durationDays ?? 0} روز`;

            // Provision VPN client on the 3x-ui panel
            let subLink: string | null = null;
            try {
              await this.vpn.createVpnUserForSubscription(sub.id);
              // Fetch the subscription link from vpnUser record
              const vpnUser = await this.prisma.vpnUser.findUnique({
                where: { subscriptionId: sub.id },
                select: { subLink: true },
              });
              subLink = vpnUser?.subLink ?? null;
            } catch (vpnErr: any) {
              console.error(`VPN provisioning failed for sub ${sub.id}: ${vpnErr?.message ?? vpnErr}`);
              // Don't fail the whole flow — subscription is created, VPN will be retried by sync worker
            }

            // Build notification message with optional subscription link
            let userMessage = `✅ رسید شما تایید شد.\n💰 ${fromMinor(amount)} ${payment.currency ?? 'IRR'} به کیف پول شما اضافه شد.${subscriptionInfo}`;
            if (subLink) {
              userMessage += `\n\n🔗 لینک اشتراک:\n\`${subLink}\``;
            }

            // Notify user with subscription info and link
            if (user.telegramId) {
              try {
                await (ctx as any).telegram.sendMessage(
                  user.telegramId,
                  userMessage,
                  { parseMode: subLink ? 'Markdown' : undefined },
                );
              } catch { /* ignore */ }
            }
          }
        }
      } catch (err: any) {
        console.error('Failed to complete order after receipt approval:', err?.message ?? err);
      }
    }

    // If no order was completed, send generic notification to user
    if (!orderCompleted && user?.telegramId) {
      try {
        await (ctx as any).telegram.sendMessage(user.telegramId, `✅ رسید شما تایید شد.\n💰 ${fromMinor(amount)} ${payment.currency ?? 'IRR'} به کیف پول شما اضافه شد.`);
      } catch { /* ignore */ }
    }
  }

  /** Reject receipt */
  async rejectReceipt(ctx: Context, paymentPublicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;

    const payment = await this.prisma.payment.findUnique({
      where: { publicId: paymentPublicId },
      include: { user: true, receipt: true },
    });
    if (!payment || payment.status !== 'AWAITING_VERIFY') {
      try {
        await (ctx as any).telegram.sendMessage(ctx.from?.id!, '❌ پرداخت یافت نشد یا قبلاً تایید شده.');
      } catch { /* ignore */ }
      return;
    }

    const rcpt = (payment as any).receipt;
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'CANCELLED' } });
      if (rcpt) await tx.receipt.update({ where: { id: rcpt.id }, data: { status: 'REJECTED' } });
    });

    const adminTelegramId = ctx.from?.id!;
    try {
      await (ctx as any).telegram.sendMessage(adminTelegramId, `❌ رسید #${paymentPublicId.slice(0, 8)} رد شد.`);
    } catch { /* ignore */ }

    const user = (payment as any).user;
    if (user?.telegramId) {
      try {
        await (ctx as any).telegram.sendMessage(user.telegramId, `❌ رسید شما رد شد. لطفاً با پشتیبانی تماس بگیرید.`);
      } catch { /* ignore */ }
    }
  }

  /** BANK CARDS — list admin-managed cards. */
  private async viewBankCards(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const cards = await this.prisma.bankCard.findMany({
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
      take: 20,
    });
    const lines = cards.map((c) => {
      const star = c.isDefault ? '⭐ ' : '';
      const st = c.isActive ? '✅' : '⛔';
      return `${star}${st} ${c.cardNumber}\n   ${c.cardHolder} · ${c.bankName ?? ''}`;
    });
    const msg = `🏦 کارت‌های بانکی (${cards.length}):\n\n${lines.join('\n\n') || '—'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
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
    const creditTypes = new Set(['DEPOSIT', 'BONUS', 'CASHBACK', 'REFERRAL_REWARD', 'GIFT', 'REFUND', 'VOUCHER_REDEEM']);
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
    const price = fromMinor(plan.price);
    const orig = plan.originalPrice ? fromMinor(plan.originalPrice) : null;
    const msg =
      `📋 ${plan.name}\n\n` +
      `🆔 ${plan.slug}\n` +
      `💰 قیمت: ${price} ${plan.currency}${orig ? ` (بدون تخفیف ${orig})` : ''}\n` +
      `📊 حجم: ${plan.trafficLimitGb ? `${plan.trafficLimitGb} GB` : 'نامحدود'}\n` +
      `📅 مدت: ${plan.durationDays ?? 0} روز\n` +
      `📱 دستگاه‌ها: ${plan.deviceLimit} · سرورها: ${plan.serverLimit}\n` +
      `🔄 تمدید: ${plan.isRenewable ? 'بله' : 'خیر'} · توقف: ${plan.allowPause ? 'بله' : 'خیر'}\n` +
      `⚡ اولویت: ${plan.priority} · وضعیت: ${plan.isEnabled ? 'فعال' : 'غیرفعال'}`;
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
    await this.plans.update(publicId, { isVisible: !plan.isVisible });
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
    const telegramId = ctx.from?.id?.toString()!;
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
    const telegramId = ctx.from?.id?.toString()!;
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
    const telegramId = ctx.from?.id?.toString()!;
    const plan = await this.plans.getRaw(publicId);
    const current =
      field === 'price'
        ? fromMinor(plan.price)
        : field === 'trafficLimitGb'
          ? plan.trafficLimitGb?.toString() ?? 'نامحدود'
          : (plan as any)[field] ?? '—';
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
      const st = !v.redeemedAt && v.redemptions < v.maxRedemptions ? '🎟️' : '✅';
      return `${st} ${v.code}\n   ${v.type} · ${v.redemptions}/${v.maxRedemptions} استفاده`;
    });
    const msg = `🎟 کدهای ووچر (${result.meta.total}):\n\n${lines.join('\n\n') || '—'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** REFERRALS — top referrers + recent commissions. */
  private async viewReferrals(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const [accounts, commissions] = await Promise.all([
      this.prisma.affiliateAccount.findMany({ orderBy: { totalEarnings: 'desc' }, take: 8, include: { user: true } }),
      this.prisma.affiliateCommission.count({ where: { status: 'PENDING' } }),
    ]);
    const lines = accounts.map((a) => {
      const name = a.user?.firstName ?? a.user?.telegramId ?? '—';
      return `• ${name}\n   ${fromMinor(a.totalEarnings)} درآمد · ${fromMinor(a.availableBalance)} در انتظار`;
    });
    const msg = `👥 سیستم معرف\n\nکمیسیون‌های در انتظار پرداخت: ${commissions}\n\nبرترین‌ها:\n${lines.join('\n\n') || '—'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** SERVERS — list VPN servers. */
  private async viewServers(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const servers = await this.prisma.server.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { city: { include: { country: true } } },
    });
    const lines = servers.map((s) => {
      const loc = s.city ? `${s.city.country?.flag ?? ''} ${s.city.name}` : s.hostname;
      const st = s.status === 'ONLINE' ? '🟢' : s.status === 'MAINTENANCE' ? '🟡' : '🔴';
      return `${st} ${s.name}\n   ${loc} · ${s.status}`;
    });
    const msg = `🖥️ سرورها (${servers.length}):\n\n${lines.join('\n\n') || '—'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** PANELS — list configured VPN panels with inline detail + health buttons (spec #9). */
  private async viewPanels(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const panels = await this.prisma.vpnPanel.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    const msg =
      `🧩 پنل‌های مدیریت (${panels.length}):\n\n` +
      (panels
        .map((p) => {
          const st = p.status === 'ACTIVE' ? '🟢' : '🔴';
          const hp = p.healthStatus === 'HEALTHY' ? '✅' : p.healthStatus === 'UNHEALTHY' ? '⚠️' : '❔';
          return `${st}${hp} ${p.name}\n   ${p.type} · ${p.baseUrl}`;
        })
        .join('\n\n') || '—');
    await this.runtime.editOrSend(ctx, msg, this.panelsListKeyboard(panels, locale));
  }

  /** Inline keyboard for the panels list: detail + health per panel + ➕ new. */
  private panelsListKeyboard(panels: any[], locale: BotLocale) {
    const rows = panels.map((p) => [
      Markup.button.callback(`🩺 ${p.name}`, `apnl:detail:${p.publicId}`),
    ]);
    rows.push([Markup.button.callback(`➕ ${t(locale, 'admin.panel.new')}`, 'apnl:new:0')]);
    rows.push([
      Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:dash'),
      Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
    ]);
    return Markup.inlineKeyboard(rows);
  }

  /** PANEL DETAIL — show one panel + health, toggle, and actions (spec #9). */
  private async viewPanelDetail(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const panel = await this.prisma.vpnPanel.findFirst({ where: { publicId } });
    if (!panel) {
      await this.viewPanels(ctx);
      return;
    }
    const meta = (panel.metadata as Record<string, unknown>) ?? {};
    const hp = panel.healthStatus === 'HEALTHY' ? '✅ سالم' : panel.healthStatus === 'UNHEALTHY' ? '⚠️ ناسالم' : '❔ نامشخص';
    const msg =
      `🧩 ${panel.name}\n\n` +
      `🆔 ${panel.publicId.slice(0, 8)}\n` +
      `🌐 آدرس: ${panel.baseUrl}\n` +
      `📦 نوع: ${panel.type}\n` +
      `⚡ وضعیت: ${panel.status === 'ACTIVE' ? 'فعال' : 'غیرفعال'}\n` +
      `🩺 سلامت: ${hp}\n` +
      `🕒 آخرین بررسی: ${panel.lastSyncAt ? new Date(panel.lastSyncAt as any).toLocaleString('fa-IR') : 'هرگز'}\n` +
      (panel.lastSyncError ? `❌ خطا: ${panel.lastSyncError}\n` : '');
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('🩺 بررسی سلامت', `apnl:health:${publicId}`),
        Markup.button.callback(panel.status === 'ACTIVE' ? '⛔ غیرفعال' : '✅ فعال', `apnl:toggle:${publicId}`),
      ],
      [
        Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:panels'),
        Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
      ],
    ]);
    await this.runtime.editOrSend(ctx, msg, kb);
  }

  /** Probe a panel's health and re-render the detail view. */
  private async checkPanelHealth(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const panel = await this.prisma.vpnPanel.findFirst({ where: { publicId } });
    if (!panel) {
      await this.viewPanels(ctx);
      return;
    }
    await this.runtime.alert(ctx, '🔍 در حال بررسی...');
    try {
      const health = await this.panels.checkHealth(panel.id);
      await this.runtime.alert(ctx, health.reachable ? '✅ پنل در دسترس است' : '⚠️ پنل در دسترس نیست');
    } catch (err: any) {
      await this.runtime.alert(ctx, `❌ ${err.message ?? 'خطا'}`);
    }
    await this.viewPanelDetail(ctx, publicId);
  }

  /** Toggle a panel ACTIVE/INACTIVE. */
  private async togglePanel(ctx: Context, publicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const panel = await this.prisma.vpnPanel.findFirst({ where: { publicId } });
    if (!panel) {
      await this.viewPanels(ctx);
      return;
    }
    const next = panel.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await this.prisma.vpnPanel.update({ where: { id: panel.id }, data: { status: next } });
    await this.viewPanelDetail(ctx, publicId);
  }

  /** Start the add-panel wizard: ask for the panel name. */
  private async startPanelWizard(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = ctx.from?.id?.toString()!;
    await this.runtime.setState(telegramId, 'admin_panel_awaiting_field', {
      adminWizard: 'panel_create',
      adminField: 'name',
      adminDraft: {},
    });
    await this.runtime.pushMenu(telegramId, 'admin_panels');
    const msg =
      `➕ افزودن پنل جدید (۱/۴)\n\n` +
      `نام پنل را وارد کنید:\n` +
      `(مثال: 3x-ui سرور اصلی)\n\n` +
      `❌ برای لغو /cancel را بفرستید.`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
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
    const wallets = await this.prisma.cryptoWallet.findMany({
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
      take: 20,
    });
    const lines = wallets.map((w) => {
      const star = w.isDefault ? '⭐ ' : '';
      const st = w.isActive ? '✅' : '⛔';
      return `${star}${st} ${w.currency}\n   ${w.address}\n   شبکه: ${w.network ?? '—'}`;
    });
    const msg = `₿ کیف پول‌های کریپتو (${wallets.length}):\n\n${lines.join('\n\n') || '—'}`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** GATEWAY — online payment gateway status. */
  private async viewGateway(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const enabled = await this.prisma.systemSetting.findUnique({ where: { key: 'online_gateway.enabled' } });
    const msg =
      `🔌 درگاه پرداخت آنلاین\n\n` +
      `وضعیت: ${enabled?.value === 'true' ? '✅ فعال' : '⛔ غیرفعال'}\n\n` +
      `پیکربندی در فایل .env انجام می‌شود.`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** BROADCAST — send a message to all active users. */
  private async viewBroadcast(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const total = await this.prisma.user.count({ where: { status: 'ACTIVE' } });
    const telegramId = ctx.from?.id?.toString()!;
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
    const telegramId = ctx.from?.id?.toString()!;
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
    await this.runtime.editOrSend(ctx, `📣 پیام شما:\n\n${text}\n\n👥 ارسال به ${total} کاربر فعال؟`, kb);
    return true;
  }

  /** Execute the broadcast — send message to all active users. */
  async onBroadcastConfirm(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = ctx.from?.id?.toString()!;
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
    const telegramId = ctx.from?.id?.toString()!;
    await this.runtime.clearState(telegramId);
    await this.runtime.editOrSend(ctx, '❌ ارسال همگانی لغو شد.', this.backHomeKeyboard(locale));
  }

  /** Approve a pending payment receipt — mark as APPROVED. */
  async onApprovePayment(ctx: Context, paymentPublicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.runtime.alert(ctx);
    try {
      const payment = await this.prisma.payment.findFirst({ where: { publicId: paymentPublicId } });
      if (!payment) {
        await this.runtime.editOrSend(ctx, '❌ پرداخت یافت نشد.', this.backHomeKeyboard(locale));
        return;
      }
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'CONFIRMED' },
      });
      await this.runtime.alert(ctx, '✅ پرداخت تایید شد');
      await this.viewPayments(ctx);
    } catch (err: any) {
      await this.runtime.editOrSend(ctx, this.runtime.translateError(locale, err), this.backHomeKeyboard(locale));
    }
  }

  /** Reject a pending payment receipt — mark as FAILED. */
  async onRejectPayment(ctx: Context, paymentPublicId: string): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    await this.runtime.alert(ctx);
    try {
      const payment = await this.prisma.payment.findFirst({ where: { publicId: paymentPublicId } });
      if (!payment) {
        await this.runtime.editOrSend(ctx, '❌ پرداخت یافت نشد.', this.backHomeKeyboard(locale));
        return;
      }
      // Reset to PENDING so the user can retry
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'PENDING' },
      });
      await this.runtime.alert(ctx, '❌ پرداخت رد شد');
      await this.viewPayments(ctx);
    } catch (err: any) {
      await this.runtime.editOrSend(ctx, this.runtime.translateError(locale, err), this.backHomeKeyboard(locale));
    }
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
      (editable.map((s) => `• ${s.key}: ${s.value}${s.isPublic ? ' 👁️' : ''}`).join('\n') || '—');
    const rows = editable.slice(0, 12).map((s) => [
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
    const telegramId = ctx.from?.id?.toString()!;
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
      `مقدار فعلی: ${setting.value}\n\n` +
      `مقدار جدید را وارد کنید:`;
    await this.runtime.editOrSend(ctx, msg, this.backHomeKeyboard(locale));
  }

  /** Start creating a new setting: ask for the key. */
  private async startSettingCreate(ctx: Context): Promise<void> {
    const locale = await this.guard(ctx);
    if (!locale) return;
    const telegramId = ctx.from?.id?.toString()!;
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
  // the final step calls the relevant service (PlansService.create/update,
  // SettingsService.upsert, PanelsService.create).
  // -------------------------------------------------------------------------

  /**
   * Entry point for admin wizard text input. Returns true if the message was
   * consumed by a wizard (so the caller can short-circuit normal text handling).
   * Handles /cancel to abort any active wizard.
   */
  async onWizardText(ctx: Context, text: string): Promise<boolean> {
    const telegramId = ctx.from?.id?.toString()!;
    const session = await this.runtime.getSession(telegramId);
    const state = session.state;
    const locale = await this.runtime.getLocale(telegramId);

    if (text.trim() === '/cancel') {
      if (
        state === 'admin_plan_awaiting_field' ||
        state === 'admin_setting_awaiting_value' ||
        state === 'admin_panel_awaiting_field'
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
    if (state === 'admin_setting_awaiting_value') {
      await this.handleSettingWizardText(ctx, text);
      return true;
    }
    if (state === 'admin_panel_awaiting_field') {
      await this.handlePanelWizardText(ctx, text);
      return true;
    }
    return false;
  }

  // ---- Plan wizard (create + edit-field) ----

  private async handlePlanWizardText(ctx: Context, text: string): Promise<void> {
    const locale = await this.runtime.getLocale(ctx.from!.id.toString());
    const telegramId = ctx.from!.id.toString();
    const session = await this.runtime.getSession(telegramId);
    const data = session.data ?? {};
    const wizard = data.adminWizard as 'plan_create' | 'plan_edit';
    const field = (data.adminField as string) ?? 'name';
    const draft = (data.adminDraft as Record<string, unknown>) ?? {};

    try {
      if (wizard === 'plan_create') {
        await this.handlePlanCreateStep(ctx, locale, telegramId, field, draft, text);
      } else {
        await this.handlePlanEditStep(ctx, locale, telegramId, data.adminTargetId as string, field, text);
      }
    } catch (err: any) {
      await this.runtime.clearState(telegramId);
      await this.runtime.editOrSend(ctx, this.runtime.translateError(locale, err), this.backHomeKeyboard(locale));
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
      if (!Number.isFinite(n) || n < 0) {
        await this.runtime.editOrSend(ctx, '❌ قیمت نامعتبر است. عدد وارد کنید:', this.backHomeKeyboard(locale));
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
        await this.runtime.editOrSend(ctx, '❌ مدت نامعتبر است. عدد روز وارد کنید:', this.backHomeKeyboard(locale));
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
        currency: 'USD',
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
      if (!Number.isFinite(n) || n < 0) {
        await this.runtime.editOrSend(ctx, '❌ قیمت نامعتبر. عدد وارد کنید:', this.backHomeKeyboard(locale));
        return;
      }
      update.price = value;
    } else if (field === 'trafficLimitGb') {
      update.trafficLimitGb = value === '' || value === '0' ? null : parseInt(value, 10);
    } else if (field === 'durationDays' || field === 'deviceLimit' || field === 'priority') {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0) {
        await this.runtime.editOrSend(ctx, '❌ عدد نامعتبر. عدد صحیح وارد کنید:', this.backHomeKeyboard(locale));
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
    const locale = await this.runtime.getLocale(ctx.from!.id.toString());
    const telegramId = ctx.from!.id.toString();
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

  // ---- Panel wizard (create: name -> baseUrl -> username -> password -> done) ----

  private async handlePanelWizardText(ctx: Context, text: string): Promise<void> {
    const locale = await this.runtime.getLocale(ctx.from!.id.toString());
    const telegramId = ctx.from!.id.toString();
    const session = await this.runtime.getSession(telegramId);
    const data = session.data ?? {};
    const field = (data.adminField as string) ?? 'name';
    const draft = (data.adminDraft as Record<string, unknown>) ?? {};
    const value = text.trim();

    try {
      if (field === 'name') {
        draft.name = value;
        await this.runtime.setState(telegramId, 'admin_panel_awaiting_field', {
          adminWizard: 'panel_create',
          adminField: 'baseUrl',
          adminDraft: draft,
        });
        await this.runtime.editOrSend(
          ctx,
          `➕ افزودن پنل (۲/۴)\n\nنام: ${value}\n\nآدرس پنل را وارد کنید (مثال http://127.0.0.1:2053):`,
          this.backHomeKeyboard(locale),
        );
        return;
      }
      if (field === 'baseUrl') {
        draft.baseUrl = value;
        await this.runtime.setState(telegramId, 'admin_panel_awaiting_field', {
          adminWizard: 'panel_create',
          adminField: 'username',
          adminDraft: draft,
        });
        await this.runtime.editOrSend(
          ctx,
          `➕ افزودن پنل (۳/۴)\n\nنام کاربری پنل را وارد کنید:`,
          this.backHomeKeyboard(locale),
        );
        return;
      }
      if (field === 'username') {
        draft.username = value;
        await this.runtime.setState(telegramId, 'admin_panel_awaiting_field', {
          adminWizard: 'panel_create',
          adminField: 'password',
          adminDraft: draft,
        });
        await this.runtime.editOrSend(
          ctx,
          `➕ افزودن پنل (۴/۴)\n\nرمز عبور پنل را وارد کنید:`,
          this.backHomeKeyboard(locale),
        );
        return;
      }
      if (field === 'password') {
        draft.password = value;
        const created = await this.panels.create({
          name: draft.name as string,
          type: 'SANITY',
          baseUrl: draft.baseUrl as string,
          apiKey: 'sanity-session-auth',
          isActive: true,
          extraConfig: {
            username: draft.username,
            password: draft.password,
            timeoutMs: 15000,
          },
        });
        await this.runtime.clearState(telegramId);
        const msg =
          `✅ پنل افزوده شد!\n\n` +
          `🆔 ${created.publicId.slice(0, 8)}\n` +
          `🧩 ${created.name}\n` +
          `🌐 ${created.baseUrl}`;
        const kb = Markup.inlineKeyboard([
          [Markup.button.callback('🩺 بررسی سلامت', `apnl:health:${created.publicId}`)],
          [
            Markup.button.callback(`◀️ ${t(locale, 'menu.back')}`, 'adm:panels'),
            Markup.button.callback(`🏠 ${t(locale, 'menu.home')}`, 'home'),
          ],
        ]);
        await this.runtime.editOrSend(ctx, msg, kb);
      }
    } catch (err: any) {
      await this.runtime.clearState(telegramId);
      await this.runtime.editOrSend(ctx, this.runtime.translateError(locale, err), this.backHomeKeyboard(locale));
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Verify admin role; return locale if OK (renders access-denied + null if not). */
  private async guard(ctx: Context): Promise<BotLocale | null> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    if (!(await this.assertAdmin(ctx, locale))) return null;
    return locale;
  }

  /** Verify the caller is an admin; show access-denied + return false if not. */
  private async assertAdmin(ctx: Context, locale: BotLocale): Promise<boolean> {
    const telegramId = ctx.from?.id?.toString()!;
    const session = await this.runtime.getSession(telegramId);
    const normalize = (s?: string) => (s ? s.trim().replace(/^\+/, '') : '');
    const isConfiguredSuperAdmin = normalize(config.superAdmin.telegramId) === normalize(telegramId);

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

    const isDbConfiguredSuperAdmin = normalize(user?.telegramId ?? undefined) === normalize(config.superAdmin.telegramId);
    const role = isDbConfiguredSuperAdmin ? 'SUPER_ADMIN' : user?.role;

    if (role !== 'SUPER_ADMIN' && role !== 'ADMIN' && role !== 'OPERATOR') {
      await this.runtime.editOrSend(ctx, t(locale, 'admin.access.denied'), this.backHomeKeyboard(locale));
      return false;
    }
    return true;
  }
}
