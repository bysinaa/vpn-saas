/**
 * Central registry of queue names. Using constants avoids typos and
 * makes discovery of all background workers trivial.
 */
export const QUEUES = {
  PAYMENTS: 'payments',
  PANEL_SYNC: 'panel-sync',
  NOTIFICATIONS: 'notifications',
  BROADCAST: 'broadcast',
  SUBSCRIPTIONS: 'subscriptions',
  VPN_USERS: 'vpn-users',
  CRYPTO_VERIFY: 'crypto-verify',
  REFERRAL_REWARDS: 'referral-rewards',
  ANALYTICS: 'analytics',
  EMAIL: 'email',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOB_NAMES = {
  // payments
  VERIFY_RECEIPT: 'verify-receipt',
  INITIATE_ONLINE_PAYMENT: 'initiate-online-payment',
  VERIFY_ONLINE_PAYMENT: 'verify-online-payment',
  SETTLE_PAYMENT: 'settle-payment',
  REFUND_PAYMENT: 'refund-payment',
  // panel
  PANEL_CREATE_USER: 'panel-create-user',
  PANEL_UPDATE_USER: 'panel-update-user',
  PANEL_DELETE_USER: 'panel-delete-user',
  PANEL_RESET_TRAFFIC: 'panel-reset-traffic',
  PANEL_RENEW: 'panel-renew',
  PANEL_SYNC_ALL: 'panel-sync-all',
  PANEL_HEALTH_CHECK: 'panel-health-check',
  // notifications
  SEND_NOTIFICATION: 'send-notification',
  SEND_TELEGRAM_MESSAGE: 'send-telegram-message',
  // broadcast
  PROCESS_BROADCAST: 'process-broadcast',
  SEND_BROADCAST_TARGET: 'send-broadcast-target',
  // subscriptions
  EXPIRE_SUBSCRIPTION: 'expire-subscription',
  LOW_TRAFFIC_ALERT: 'low-traffic-alert',
  TRIAL_EXPIRE: 'trial-expire',
  // crypto
  CHECK_CRYPTO_PAYMENT: 'check-crypto-payment',
  // analytics
  SNAPSHOT_ANALYTICS: 'snapshot-analytics',
  // referrals
  PROCESS_REFERRAL: 'process-referral',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
