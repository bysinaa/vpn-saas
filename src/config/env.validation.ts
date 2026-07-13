import { z } from 'zod';

/**
 * Centralized environment configuration schema validated with Zod.
 * The app fails fast on boot if required variables are missing/invalid.
 *
 * This guarantees type-safe access to env vars across the codebase.
 */

const toNumber = (val: string | undefined, def: number): number => {
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
};

const toBool = (val: string | undefined, def: boolean): boolean => {
  if (val === undefined) return def;
  return ['true', '1', 'yes'].includes(val.toLowerCase());
};

const toList = (val: string | undefined): string[] =>
  (val ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Zod boolean preprocessor. z.coerce.boolean() is WRONG for env parsing because
 * Boolean("false") === true — any non-empty string is truthy. This uses the
 * toBool() helper which correctly maps 'false'/'0'/'no' to false and
 * 'true'/'1'/'yes' to true.
 */
const envBool = (def: boolean) =>
  z.preprocess((v) => (v === undefined || v === '' ? def : toBool(v as string, def)), z.boolean());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test', 'staging']).default('development'),
  APP_NAME: z.string().default('vpn-saas'),
  APP_PORT: z.coerce.number().default(3000),
  APP_HOST: z.string().default('0.0.0.0'),
  APP_URL: z.string().url(),
  API_PREFIX: z.string().default('api'),
  API_VERSION: z.string().default('v1'),
  GLOBAL_PREFIX: z.string().default('api/v1'),
  CORS_ORIGINS: z.string().default(''),
  RATE_LIMIT_TTL: z.coerce.number().default(60),
  RATE_LIMIT_LIMIT: z.coerce.number().default(120),

  DATABASE_URL: z.string().min(1),
  PRISMA_MIGRATE_ON_BOOT: envBool(false),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_DB: z.coerce.number().default(0),
  CACHE_TTL_DEFAULT: z.coerce.number().default(300),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  JWT_ISSUER: z.string().default('vpn-saas'),
  JWT_AUDIENCE: z.string().default('vpn-saas-clients'),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: envBool(true),
  S3_PUBLIC_URL: z.string().url(),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_WEBHOOK_URL: z.string().optional().default(''),
  TELEGRAM_BOT_WEBHOOK_PATH: z.string().default('/telegram/webhook'),
  TELEGRAM_BOT_USE_WEBHOOK: envBool(false),
  TELEGRAM_ADMIN_IDS: z.string().default(''),
  TELEGRAM_MINI_APP_URL: z.string().default(''),

  // Outbound proxy — ALL project traffic routes through this SOCKS5/HTTP proxy.
  // Leave empty to disable proxying. Bypass list (comma-separated) skips proxy for matching hosts.
  // NOTE: use socks5h:// (not socks5://) so the PROXY resolves DNS remotely —
  // this avoids DNS poisoning for filtered domains (e.g. api.telegram.org) in Iran.
  PROXY_URL: z.string().default(''),
  PROXY_BYPASS: z.string().default('localhost,127.0.0.1,::1'),

  SANITY_PANEL_BASE_URL: z.string().url(),
  // 3x-ui v3.x uses session-cookie auth (login flow); username/password are used
  // to obtain a session. API_KEY is kept for backward-compat / future token API.
  SANITY_PANEL_API_KEY: z.string().default(''),
  SANITY_PANEL_USERNAME: z.string().default('admin'),
  SANITY_PANEL_PASSWORD: z.string().default(''),
  SANITY_PANEL_TIMEOUT_MS: z.coerce.number().default(15000),
  SANITY_PANEL_MAX_RETRIES: z.coerce.number().default(3),
  SANITY_PANEL_SYNC_CRON: z.string().default('0 */6 * * *'),
  SANITY_PANEL_SUB_PORT: z.coerce.number().default(2053),
  SANITY_PANEL_SUB_PATH: z.string().default('sub'),

  ONLINE_GATEWAY_ENABLED: envBool(true),
  ONLINE_GATEWAY_BASE_URL: z.string().default(''),
  ONLINE_GATEWAY_MERCHANT_ID: z.string().default(''),
  ONLINE_GATEWAY_API_KEY: z.string().default(''),
  ONLINE_GATEWAY_CALLBACK_URL: z.string().default(''),

  CRYPTO_ENABLED: envBool(true),
  CRYPTO_API_BASE_URL: z.string().default(''),
  CRYPTO_API_KEY: z.string().default(''),
  CRYPTO_WEBHOOK_SECRET: z.string().default(''),

  CARD_TO_CARD_ENABLED: envBool(true),
  CARD_TO_CARD_CARD_NUMBER: z.string().default(''),
  CARD_TO_CARD_HOLDER_NAME: z.string().default(''),

  BCRYPT_ROUNDS: z.coerce.number().default(12),
  WEBHOOK_SECRET: z.string().min(8),
  ENCRYPTION_KEY: z.string().min(16),
  COOKIE_SECURE: envBool(false),
  CSRF_ENABLED: envBool(false),

  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(10),
  RECEIPT_ALLOWED_MIMES: z.string().default('image/jpeg,image/png,image/webp,application/pdf'),

  QUEUE_PREFIX: z.string().default('vpn-saas'),
  QUEUE_DEFAULT_ATTEMPTS: z.coerce.number().default(3),
  QUEUE_DEFAULT_BACKOFF: z.string().default('exponential'),
  QUEUE_DEFAULT_BACKOFF_DELAY: z.coerce.number().default(5000),

  PINO_LEVEL: z.string().default('info'),
  PINO_PRETTY: envBool(true),
  PROMETHEUS_ENABLED: envBool(true),
  PROMETHEUS_PATH: z.string().default('/metrics'),
  HEALTH_CHECK_PATH: z.string().default('/health'),
  BULL_BOARD_PATH: z.string().default('/admin/queues'),

  SUPER_ADMIN_EMAIL: z.string().email(),
  SUPER_ADMIN_PASSWORD: z.string().min(8),
  SUPER_ADMIN_TELEGRAM_ID: z.string().optional().default(''),
});

export type AppConfig = z.infer<typeof envSchema>;

/** Parse + validate environment, throwing a clear error on failure. */
export function loadAndValidateEnv(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error('❌ Invalid environment configuration:\n' + errors);
    throw new Error('Invalid environment configuration. See errors above.');
  }
  return parsed.data;
}

export const configHelpers = { toNumber, toBool, toList };