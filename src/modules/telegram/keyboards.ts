import { Markup } from 'telegraf';
import type { BotLocale } from './telegram.types';
import { BOT_ACTIONS, TICKET_CATEGORIES } from './telegram.types';
import { t } from './i18n';

/** Whether the user role is an admin-capable role (spec #9). */
export function isAdminRole(role?: string | null): boolean {
  return role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'OPERATOR';
}

// =============================================================================
// Main menu — INLINE keyboard (spec #7: edit-in-place, no "glassy" reply buttons)
// =============================================================================

/**
 * Builds the main menu as an INLINE keyboard (spec #7 UX).
 *
 * Every button is a callback button attached to the menu message, so taps
 * edit the existing message in place instead of sending a new one. 
 * Admin users (SUPER_ADMIN / ADMIN / OPERATOR) get ONLY the "Admin Panel" button;
 * normal users get only user-specific options.
 */
export function mainMenuKeyboard(locale: BotLocale, role?: string | null) {
  const B = (labelKey: string, action: string) => Markup.button.callback(t(locale, labelKey), action);
  
  // Admins get ONLY the admin panel button, not user options
  if (isAdminRole(role)) {
    return Markup.inlineKeyboard([
      [B('menu.admin', BOT_ACTIONS.ADMIN)],
    ]);
  }
  
  // Regular users get only user options
  return Markup.inlineKeyboard([
    [B('menu.buy', BOT_ACTIONS.BUY), B('menu.trial', BOT_ACTIONS.TRIAL)],
    [B('menu.voucher', BOT_ACTIONS.VOUCHER), B('menu.wallet', BOT_ACTIONS.WALLET)],
    [B('menu.subs', BOT_ACTIONS.MY_SUBS), B('menu.profile', BOT_ACTIONS.PROFILE)],
    [B('menu.referral', BOT_ACTIONS.REFERRAL), B('menu.support', BOT_ACTIONS.SUPPORT)],
    [B('menu.language', 'langmenu')],
  ]);
}

/** Language picker inline keyboard. */
export function languageKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🇮🇷 فارسی', BOT_ACTIONS.LANGUAGE_FA),
      Markup.button.callback('🇬🇧 English', BOT_ACTIONS.LANGUAGE_EN),
    ],
  ]);
}

// =============================================================================
// Navigation helpers
// =============================================================================

/** Standard nav row: Back / Home (+ optional Refresh / Cancel). */
export function navKeyboard(locale: BotLocale, opts: { home?: boolean; refresh?: boolean; cancel?: boolean } = {}) {
  const row: any[] = [Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK)];
  if (opts.refresh) row.push(Markup.button.callback(t(locale, 'menu.refresh'), BOT_ACTIONS.REFRESH));
  if (opts.cancel) row.push(Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL));
  const rows: any[][] = [row];
  if (opts.home !== false) rows.push([Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME)]);
  return Markup.inlineKeyboard(rows);
}

/** Cancel-only keyboard (for one-step prompts). */
export function cancelKeyboard(locale: BotLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL)],
  ]);
}

/** Back + Home only (post-action confirmation screens). */
export function homeBackKeyboard(locale: BotLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK), Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME)],
  ]);
}

// =============================================================================
// Buy / Plans
// =============================================================================

/** Plan selection inline keyboard (paginated). */
export function plansKeyboard(
  locale: BotLocale,
  plans: Array<{ publicId: string; name: string; priceLabel: string }>,
  page = 0,
  totalPages = 1,
) {
  const rows = plans.map((p) => [
    Markup.button.callback(`${p.name} — ${p.priceLabel}`, `plan:${p.publicId}`),
  ]);
  const navRow: any[] = [];
  if (page > 0) navRow.push(Markup.button.callback('⬅️', `planpage:${page - 1}`));
  if (totalPages > 1) navRow.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'));
  if (page < totalPages - 1) navRow.push(Markup.button.callback('➡️', `planpage:${page + 1}`));
  if (navRow.length) rows.push(navRow);
  rows.push([Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL)]);
  return Markup.inlineKeyboard(rows);
}

/** Server selection inline keyboard. */
export function serversKeyboard(
  locale: BotLocale,
  servers: Array<{ publicId: string; label: string; status: string; loadPct: number }>,
) {
  const rows = servers.map((s) => {
    const emoji = s.status === 'ONLINE' ? '🟢' : s.status === 'DEGRADED' ? '🟠' : '🔴';
    const disabled = s.status !== 'ONLINE';
    return [
      Markup.button.callback(
        `${emoji} ${s.label} (${s.loadPct}%)`,
        `server:${s.publicId}`,
        disabled,
      ),
    ];
  });
  rows.push([Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK)]);
  return Markup.inlineKeyboard(rows);
}

/** Order confirmation keyboard (proceed to payment). */
export function confirmOrderKeyboard(locale: BotLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, 'confirm.proceed'), 'orderproceed')],
    [
      Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK),
      Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL),
    ],
  ]);
}

/** Payment method picker inline keyboard. */
export function paymentMethodKeyboard(locale: BotLocale) {
  // Spec #5: vouchers activate VPN subscriptions directly (standalone flow),
  // they are NO LONGER a payment method for orders.
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t(locale, 'pay.wallet'), 'paymethod:WALLET'),
      Markup.button.callback(t(locale, 'pay.online'), 'paymethod:ONLINE'),
    ],
    [
      Markup.button.callback(t(locale, 'pay.card'), 'paymethod:CARD_TO_CARD'),
      Markup.button.callback(t(locale, 'pay.crypto'), 'paymethod:CRYPTO'),
    ],
    [
      Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK),
      Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL),
    ],
  ]);
}

/** Online gateway link keyboard. */
export function onlineGatewayKeyboard(locale: BotLocale, url: string) {
  return Markup.inlineKeyboard([
    [Markup.button.url(t(locale, 'pay.online.open'), url)],
    [Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME)],
  ]);
}

/** Crypto confirm keyboard. */
export function cryptoConfirmKeyboard(locale: BotLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, 'pay.crypto.confirm'), 'cryptoconfirm')],
    [Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME)],
  ]);
}

// =============================================================================
// Wallet
// =============================================================================

export function walletKeyboard(locale: BotLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, 'wallet.deposit'), 'wdeposit')],
    [
      Markup.button.callback(t(locale, 'wallet.history'), 'whistory'),
      Markup.button.callback(t(locale, 'wallet.giftHistory'), 'wgift'),
    ],
    [Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK), Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME)],
  ]);
}

export function depositMethodKeyboard(locale: BotLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, 'wallet.deposit.card'), 'depmethod:CARD_TO_CARD')],
    [Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK), Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL)],
  ]);
}

/** Pre-set wallet deposit amount buttons (Toman) — no custom amount. */
export function walletDepositAmountsKeyboard(locale: BotLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💰 100,000 Toman', 'wdepamt:100000')],
    [Markup.button.callback('💰 200,000 Toman', 'wdepamt:200000')],
    [Markup.button.callback('💰 500,000 Toman', 'wdepamt:500000')],
    [Markup.button.callback(t(locale, 'menu.back'), 'wdeposit')],
    [Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL)],
  ]);
}

/**
 * Fixed Toman deposit-amount picker (spec #7).
 * Buttons: 50,000 / 100,000 / 200,000 / 500,000 + Custom Amount.
 * The amounts are always Toman (IRR minor units) — the callback carries the
 * minor-unit value so the flow doesn't need to re-parse.
 */
export function depositAmountKeyboard(locale: BotLocale, amounts: number[]) {
  const rows: any[][] = [];
  for (const amt of amounts) {
    const display = new Intl.NumberFormat('en-US').format(amt);
    rows.push([Markup.button.callback(`${display} Toman`, `depamt:${amt}`)]);
  }
  rows.push([Markup.button.callback(t(locale, 'wallet.deposit.custom'), 'depamt:CUSTOM')]);
  rows.push([
    Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK),
    Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL),
  ]);
  return Markup.inlineKeyboard(rows);
}

/**
 * Crypto currency picker — shows one button per active crypto wallet.
 * Each button carries the wallet publicId so the flow can fetch the address.
 */
export function cryptoPickerKeyboard(
  locale: BotLocale,
  wallets: Array<{ publicId: string; currency: string; network?: string | null }>,
) {
  const rows = wallets.map((w) => [
    Markup.button.callback(
      `${w.currency}${w.network ? ` (${w.network})` : ''}`,
      `crypto:${w.publicId}`,
    ),
  ]);
  rows.push([
    Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK),
    Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL),
  ]);
  return Markup.inlineKeyboard(rows);
}

// =============================================================================
// Subscriptions
// =============================================================================

export function subscriptionsListKeyboard(
  locale: BotLocale,
  subs: Array<{ publicId: string; label: string }>,
  page = 0,
  totalPages = 1,
) {
  const rows = subs.map((s) => [Markup.button.callback(s.label, `sub:${s.publicId}`)]);
  const navRow: any[] = [];
  if (page > 0) navRow.push(Markup.button.callback('⬅️', `subpage:${page - 1}`));
  if (totalPages > 1) navRow.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'));
  if (page < totalPages - 1) navRow.push(Markup.button.callback('➡️', `subpage:${page + 1}`));
  if (navRow.length) rows.push(navRow);
  rows.push([
    Markup.button.callback(t(locale, 'menu.refresh'), BOT_ACTIONS.REFRESH),
    Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME),
  ]);
  return Markup.inlineKeyboard(rows);
}

/** Subscription detail action keyboard. */
export function subscriptionDetailKeyboard(locale: BotLocale, subPublicId: string, opts: { canReset?: boolean } = {}) {
  const rows: any[][] = [
    [Markup.button.callback(t(locale, 'sub.link'), `sublink:${subPublicId}`)],
    [
      Markup.button.callback(t(locale, 'sub.renew'), `subrenew:${subPublicId}`),
      Markup.button.callback(t(locale, 'sub.extend'), `subextend:${subPublicId}`),
    ],
    [
      Markup.button.callback(t(locale, 'sub.upgrade'), `subupgrade:${subPublicId}`),
      Markup.button.callback(t(locale, 'sub.guide'), `subguide:${subPublicId}`),
    ],
    [Markup.button.callback(t(locale, 'sub.report'), `subreport:${subPublicId}`)],
  ];
  if (opts.canReset) {
    rows.splice(1, 0, [Markup.button.callback(t(locale, 'sub.reset'), `subreset:${subPublicId}`)]);
  }
  rows.push([
    Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK),
    Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME),
  ]);
  return Markup.inlineKeyboard(rows);
}

/** Confirmation keyboard (yes/no) for dangerous actions. */
export function yesNoKeyboard(locale: BotLocale, action: string, id: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t(locale, 'menu.confirm'), `yes:${action}:${id}`),
      Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL),
    ],
  ]);
}

/** Upgrade plan picker. subPublicId is stored in session; callback only carries planPublicId. */
export function upgradePlansKeyboard(
  locale: BotLocale,
  plans: Array<{ publicId: string; name: string; priceLabel: string }>,
) {
  const rows = plans.map((p) => [
    Markup.button.callback(`${p.name} — ${p.priceLabel}`, `upg:${p.publicId}`),
  ]);
  rows.push([Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK)]);
  return Markup.inlineKeyboard(rows);
}

// =============================================================================
// Profile
// =============================================================================

export function profileKeyboard(locale: BotLocale) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t(locale, 'profile.editLanguage'), 'langmenu'),
      Markup.button.callback(t(locale, 'profile.referral'), BOT_ACTIONS.REFERRAL),
    ],
    [
      Markup.button.callback(t(locale, 'profile.wallet'), BOT_ACTIONS.WALLET),
      Markup.button.callback(t(locale, 'profile.orders'), 'profileorders'),
    ],
    [Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK), Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME)],
  ]);
}

// =============================================================================
// Referral
// =============================================================================

export function referralKeyboard(locale: BotLocale, link: string, shareText: string) {
  return Markup.inlineKeyboard([
    [Markup.button.switchToChat(t(locale, 'referral.share'), shareText)],
    [Markup.button.callback(t(locale, 'referral.rules'), 'refrules')],
    [Markup.button.callback(t(locale, 'referral.history'), 'refhistory')],
    [Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK), Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME)],
  ]);
}

// =============================================================================
// Support / Tickets
// =============================================================================

export function supportMenuKeyboard(locale: BotLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, 'support.newTicket'), 'newticket')],
    [
      Markup.button.callback(t(locale, 'support.openTickets'), 'tickets:OPEN'),
      Markup.button.callback(t(locale, 'support.closedTickets'), 'tickets:CLOSED'),
    ],
    [Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK), Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME)],
  ]);
}

export function ticketCategoryKeyboard(locale: BotLocale) {
  const rows = TICKET_CATEGORIES.map((c) => [
    Markup.button.callback(t(locale, `support.category.${c}`), `tcat:${c}`),
  ]);
  rows.push([Markup.button.callback(t(locale, 'menu.cancel'), BOT_ACTIONS.CANCEL)]);
  return Markup.inlineKeyboard(rows);
}

export function ticketsListKeyboard(
  locale: BotLocale,
  tickets: Array<{ publicId: string; label: string }>,
  page = 0,
  totalPages = 1,
) {
  const rows = tickets.map((tk) => [Markup.button.callback(tk.label, `ticket:${tk.publicId}`)]);
  const navRow: any[] = [];
  if (page > 0) navRow.push(Markup.button.callback('⬅️', `tkpage:${page - 1}`));
  if (totalPages > 1) navRow.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'));
  if (page < totalPages - 1) navRow.push(Markup.button.callback('➡️', `tkpage:${page + 1}`));
  if (navRow.length) rows.push(navRow);
  rows.push([
    Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK),
    Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME),
  ]);
  return Markup.inlineKeyboard(rows);
}

// =============================================================================
// Admin (spec #9, #10) — role-gated professional dashboard
// =============================================================================

/**
 * Admin dashboard keyboard — ~20 sections (spec #10).
 * Each button opens the corresponding management view; the web-panel URL
 * button deep-links to the web admin where full CRUD is performed (the bot
 * is a companion dashboard, not a replacement for the REST admin API).
 */
export function adminDashboardKeyboard(locale: BotLocale, webPanelUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, 'admin.section.dashboard'), BOT_ACTIONS.ADM_DASH)],
    [
      Markup.button.callback(t(locale, 'admin.section.users'), BOT_ACTIONS.ADM_USERS),
      Markup.button.callback(t(locale, 'admin.section.payments'), BOT_ACTIONS.ADM_PAY),
    ],
    [
      Markup.button.callback(t(locale, 'admin.section.cards'), BOT_ACTIONS.ADM_CARDS),
      Markup.button.callback(t(locale, 'admin.section.wallet'), BOT_ACTIONS.ADM_WALLET),
    ],
    [
      Markup.button.callback(t(locale, 'admin.section.plans'), BOT_ACTIONS.ADM_PLANS),
      Markup.button.callback(t(locale, 'admin.section.vouchers'), BOT_ACTIONS.ADM_VOUCHERS),
    ],
    [
      Markup.button.callback(t(locale, 'admin.section.referral'), BOT_ACTIONS.ADM_REF),
      Markup.button.callback(t(locale, 'admin.section.servers'), BOT_ACTIONS.ADM_SERVERS),
    ],
    [
      Markup.button.callback(t(locale, 'admin.section.panels'), BOT_ACTIONS.ADM_PANELS),
      Markup.button.callback(t(locale, 'admin.section.trial'), BOT_ACTIONS.ADM_TRIAL),
    ],
    [
      Markup.button.callback(t(locale, 'admin.section.crypto'), BOT_ACTIONS.ADM_CRYPTO),
      Markup.button.callback(t(locale, 'admin.section.gateway'), BOT_ACTIONS.ADM_GATEWAY),
    ],
    [
      Markup.button.callback(t(locale, 'admin.section.broadcast'), BOT_ACTIONS.ADM_BROADCAST),
      Markup.button.callback(t(locale, 'admin.section.tickets'), BOT_ACTIONS.ADM_TICKETS),
    ],
    [
      Markup.button.callback(t(locale, 'admin.section.education'), BOT_ACTIONS.ADM_EDU),
      Markup.button.callback(t(locale, 'admin.section.settings'), BOT_ACTIONS.ADM_SETTINGS),
    ],
    [
      Markup.button.callback(t(locale, 'admin.section.statistics'), BOT_ACTIONS.ADM_STATS),
      Markup.button.callback(t(locale, 'admin.section.logs'), BOT_ACTIONS.ADM_LOGS),
    ],
    [Markup.button.callback(t(locale, 'admin.section.roles'), BOT_ACTIONS.ADM_ROLES)],
    // Telegram rejects URL buttons that aren't https:// or a t.me link
    // (e.g. http://localhost:3000 → 400 "Wrong HTTP URL", which would crash the
    // whole dashboard render). Only attach the web-panel button when the URL
    // is Telegram-valid; otherwise omit it so the rest of the keyboard renders.
    ...(/^https:\/\/.+/i.test(webPanelUrl) || /^https?:\/\/t\.me\//i.test(webPanelUrl)
      ? [[Markup.button.url(t(locale, 'admin.webpanel'), webPanelUrl)]]
      : []),
    [
      Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK),
      Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME),
    ],
  ]);
}

export function ticketDetailKeyboard(locale: BotLocale, ticketPublicId: string, open: boolean) {
  const rows: any[][] = [
    [Markup.button.callback(t(locale, 'ticket.reply'), `tkreply:${ticketPublicId}`)],
    [Markup.button.callback(t(locale, 'ticket.viewReplies'), `tkview:${ticketPublicId}`)],
  ];
  if (open) rows.push([Markup.button.callback(t(locale, 'ticket.close'), `tkclose:${ticketPublicId}`)]);
  rows.push([
    Markup.button.callback(t(locale, 'menu.back'), BOT_ACTIONS.BACK),
    Markup.button.callback(t(locale, 'menu.home'), BOT_ACTIONS.HOME),
  ]);
  return Markup.inlineKeyboard(rows);
}
