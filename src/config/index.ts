import { loadAndValidateEnv } from './env.validation';

/**
 * Singleton config object. Validate env once at boot and expose typed access.
 * Usage: import { config } from '@/config';
 */
const env = loadAndValidateEnv();

export const config = {
  app: {
    name: env.APP_NAME,
    env: env.NODE_ENV,
    port: env.APP_PORT,
    host: env.APP_HOST,
    url: env.APP_URL,
    apiPrefix: env.API_PREFIX,
    apiVersion: env.API_VERSION,
    globalPrefix: env.GLOBAL_PREFIX,
    corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    isProduction: env.NODE_ENV === 'production',
    isDev: env.NODE_ENV === 'development',
  },
  rateLimit: {
    ttl: env.RATE_LIMIT_TTL,
    limit: env.RATE_LIMIT_LIMIT,
  },
  database: {
    url: env.DATABASE_URL,
    migrateOnBoot: env.PRISMA_MIGRATE_ON_BOOT,
  },
  redis: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    db: env.REDIS_DB,
    cacheTtl: env.CACHE_TTL_DEFAULT,
  },
  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  },
  s3: {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    publicUrl: env.S3_PUBLIC_URL,
  },
  proxy: {
    url: env.PROXY_URL,
    bypass: env.PROXY_BYPASS.split(',').map((s) => s.trim()).filter(Boolean),
    enabled: env.PROXY_URL.length > 0,
  },
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    webhookUrl: env.TELEGRAM_BOT_WEBHOOK_URL,
    webhookPath: env.TELEGRAM_BOT_WEBHOOK_PATH,
    useWebhook: env.TELEGRAM_BOT_USE_WEBHOOK,
    adminIds: env.TELEGRAM_ADMIN_IDS.split(',').map((s) => s.trim()).filter(Boolean),
    miniAppUrl: env.TELEGRAM_MINI_APP_URL,
  },
  sanity: {
    baseUrl: env.SANITY_PANEL_BASE_URL,
    apiKey: env.SANITY_PANEL_API_KEY,
    username: env.SANITY_PANEL_USERNAME,
    password: env.SANITY_PANEL_PASSWORD,
    timeoutMs: env.SANITY_PANEL_TIMEOUT_MS,
    maxRetries: env.SANITY_PANEL_MAX_RETRIES,
    syncCron: env.SANITY_PANEL_SYNC_CRON,
    subPort: env.SANITY_PANEL_SUB_PORT,
    subPath: env.SANITY_PANEL_SUB_PATH,
  },
  xui: {
    panelUrl: env.XUI_PANEL_URL,
    username: env.XUI_USERNAME,
    password: env.XUI_PASSWORD,
    timeoutMs: env.XUI_TIMEOUT_MS,
    sessionTtlMs: env.XUI_SESSION_TTL_MS,
    defaultInboundId: env.XUI_DEFAULT_INBOUND_ID,
  },
  payments: {
    online: {
      enabled: env.ONLINE_GATEWAY_ENABLED,
      baseUrl: env.ONLINE_GATEWAY_BASE_URL,
      merchantId: env.ONLINE_GATEWAY_MERCHANT_ID,
      apiKey: env.ONLINE_GATEWAY_API_KEY,
      callbackUrl: env.ONLINE_GATEWAY_CALLBACK_URL,
    },
    crypto: {
      enabled: env.CRYPTO_ENABLED,
      apiBaseUrl: env.CRYPTO_API_BASE_URL,
      apiKey: env.CRYPTO_API_KEY,
      webhookSecret: env.CRYPTO_WEBHOOK_SECRET,
    },
    cardToCard: {
      enabled: env.CARD_TO_CARD_ENABLED,
      cardNumber: env.CARD_TO_CARD_CARD_NUMBER,
      holderName: env.CARD_TO_CARD_HOLDER_NAME,
    },
  },
  security: {
    bcryptRounds: env.BCRYPT_ROUNDS,
    webhookSecret: env.WEBHOOK_SECRET,
    encryptionKey: env.ENCRYPTION_KEY,
    cookieSecure: env.COOKIE_SECURE,
    csrfEnabled: env.CSRF_ENABLED,
    receiptAllowedMimes: env.RECEIPT_ALLOWED_MIMES.split(',').map((s) => s.trim()).filter(Boolean),
    maxUploadBytes: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  },
  queue: {
    prefix: env.QUEUE_PREFIX,
    defaultAttempts: env.QUEUE_DEFAULT_ATTEMPTS,
    defaultBackoff: env.QUEUE_DEFAULT_BACKOFF as 'exponential' | 'fixed',
    defaultBackoffDelay: env.QUEUE_DEFAULT_BACKOFF_DELAY,
  },
  monitoring: {
    pinoLevel: env.PINO_LEVEL,
    pinoPretty: env.PINO_PRETTY,
    prometheusEnabled: env.PROMETHEUS_ENABLED,
    prometheusPath: env.PROMETHEUS_PATH,
    healthPath: env.HEALTH_CHECK_PATH,
    bullBoardPath: env.BULL_BOARD_PATH,
  },
  superAdmin: {
    email: env.SUPER_ADMIN_EMAIL,
    password: env.SUPER_ADMIN_PASSWORD,
    telegramId: env.SUPER_ADMIN_TELEGRAM_ID || undefined,
  },
} as const;

export type Config = typeof config;