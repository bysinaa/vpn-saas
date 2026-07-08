import { z } from 'zod';

/**
 * Bot language pack keys. Stored as a flat object per locale.
 *
 * NOTE: Only `fa` and `en` are fully implemented right now. The schema enum
 * (Language) already supports RU/AR/TR for forward compatibility; the bot
 * accepts those codes from start links but maps them to English until native
 * packs are authored.
 */
export type BotLocale = 'fa' | 'en';

/** Conversation state machine. Persisted in Redis per Telegram id. */
export type BotState =
  | 'idle'
  // onboarding
  | 'awaiting_language'
  // buy subscription
  | 'buy_awaiting_plan'
  | 'buy_awaiting_server'
  | 'buy_awaiting_confirmation'
  | 'buy_awaiting_payment'
  // voucher (direct VPN activation — spec #5)
  | 'voucher_awaiting_code'
  // wallet / deposit
  | 'wallet_awaiting_deposit_method'
  | 'wallet_awaiting_receipt'
  | 'wallet_awaiting_crypto_confirm'
  // subscriptions
  | 'subs_viewing_list'
  | 'subs_viewing_detail'
  | 'sub_awaiting_upgrade'
  // support
  | 'support_awaiting_category'
  | 'support_awaiting_subject'
  | 'support_awaiting_message'
  // tickets
  | 'ticket_awaiting_reply'
  // referral
  | 'referral_awaiting_code'
  // admin CRUD wizards (spec #9/#10 — manage plans, settings, panels in-bot)
  | 'admin_plan_awaiting_field'
  | 'admin_setting_awaiting_value'
  | 'admin_panel_awaiting_field'
  // admin broadcast
  | 'admin_broadcast_awaiting_message'
  | 'admin_broadcast_confirm';

/**
 * Strongly-typed session payload stored in Redis. `data` carries flow-specific
 * scratch state (selected plan/server/order ids, pagination cursors, etc).
 */
export interface BotSession {
  /** Telegram user id (chat id for private messages). */
  telegramId: string;
  /** Internal user id once authenticated. */
  userId?: bigint;
  /** Current conversation state. */
  state?: BotState;
  /** Pending data for the current state. */
  data?: BotSessionData;
  /** Persisted locale. */
  locale?: BotLocale;
  /** Id of the last inline message we rendered, so we can edit-in-place. */
  lastMessageId?: number;
  /** Menu we are currently inside (for Back navigation). */
  menuStack?: BotMenu[];
}

/** Discriminated union of flow scratch data. */
export interface BotSessionData {
  // buy flow
  planPublicId?: string;
  planId?: string;
  serverPublicId?: string;
  orderId?: string;
  paymentMethod?: PaymentMethodChoice;
  cryptoCurrency?: string;
  // wallet/deposit
  depositAmountMinor?: string;
  // subscriptions
  subPublicId?: string;
  subPage?: number;
  // support
  ticketCategory?: string;
  ticketSubject?: string;
  ticketPublicId?: string;
  // admin CRUD wizards (spec #9/#10)
  adminWizard?: 'plan_create' | 'plan_edit' | 'setting_edit' | 'panel_create';
  adminTargetId?: string; // publicId of the plan/setting/panel being edited
  adminField?: string; // which field of the wizard we're awaiting text for
  adminDraft?: Record<string, unknown>; // partial draft accumulated across wizard steps
  // misc
  searchQuery?: string;
  [key: string]: unknown;
}

export type PaymentMethodChoice = 'WALLET' | 'ONLINE' | 'CARD_TO_CARD' | 'CRYPTO' | 'VOUCHER';

/** Logical menus (for Back navigation). Lower index = deeper. */
export type BotMenu =
  | 'main'
  | 'buy_categories'
  | 'buy_plans'
  | 'buy_servers'
  | 'buy_confirm'
  | 'buy_payment'
  | 'wallet'
  | 'wallet_deposit'
  | 'voucher'
  | 'admin'
  | 'subs_list'
  | 'sub_detail'
  | 'profile'
  | 'referral'
  | 'support'
  | 'tickets_list'
  | 'ticket_detail'
  | 'language'
  | 'ticket_categories'
  // admin CRUD (spec #9/#10)
  | 'admin_plans'
  | 'admin_plan_detail'
  | 'admin_settings'
  | 'admin_panels'
  | 'admin_panel_detail';

export const startAuthSchema = z.object({
  referralCode: z.string().optional(),
});

export type StartAuthInput = z.infer<typeof startAuthSchema>;

/**
 * Button callback action codes (used in inline keyboards).
 * Format: `namespace:id` so a single regex can route them.
 */
export const BOT_ACTIONS = {
  SHOW_PLANS: 'plans',
  SELECT_PLAN: 'plan:',
  WALLET: 'wallet',
  MY_SUBS: 'subs',
  BUY: 'buy',
  SUPPORT: 'support',
  TRIAL: 'trial',
  PROFILE: 'profile',
  REFERRAL: 'referral',
  LANGUAGE_FA: 'lang:fa',
  LANGUAGE_EN: 'lang:en',
  PAY_WALLET: 'pay:wallet',
  PAY_ONLINE: 'pay:online',
  PAY_CARD: 'pay:card',
  PAY_CRYPTO: 'pay:crypto',
  PAY_VOUCHER: 'pay:voucher',
  VOUCHER: 'voucher',
  ADMIN: 'admin',
  ADM_DASH: 'adm:dash',
  ADM_USERS: 'adm:users',
  ADM_PAY: 'adm:pay',
  ADM_CARDS: 'adm:cards',
  ADM_WALLET: 'adm:wallet',
  ADM_PLANS: 'adm:plans',
  ADM_VOUCHERS: 'adm:vouchers',
  ADM_REF: 'adm:ref',
  ADM_SERVERS: 'adm:servers',
  ADM_PANELS: 'adm:panels',
  ADM_TRIAL: 'adm:trial',
  ADM_CRYPTO: 'adm:crypto',
  ADM_GATEWAY: 'adm:gateway',
  ADM_BROADCAST: 'adm:broadcast',
  ADM_TICKETS: 'adm:tickets',
  ADM_EDU: 'adm:edu',
  ADM_SETTINGS: 'adm:settings',
  ADM_STATS: 'adm:stats',
  ADM_LOGS: 'adm:logs',
  ADM_ROLES: 'adm:roles',
  CANCEL: 'cancel',
  BACK: 'back',
  HOME: 'home',
  REFRESH: 'refresh',
} as const;

export type BotAction = (typeof BOT_ACTIONS)[keyof typeof BOT_ACTIONS];

/** Standard ticket categories. */
export const TICKET_CATEGORIES = ['GENERAL', 'PAYMENT', 'TECHNICAL', 'SUBSCRIPTION', 'ACCOUNT', 'OTHER'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** Convert between the Prisma Language enum and the bot locale. */
export function prismaLanguageToLocale(lang: string | null | undefined): BotLocale {
  return lang === 'FA' ? 'fa' : 'en';
}

export function localeToPrismaLanguage(locale: BotLocale): 'FA' | 'EN' {
  return locale === 'fa' ? 'FA' : 'EN';
}
