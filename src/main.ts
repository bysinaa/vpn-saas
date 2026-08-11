import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Logger as PinoLogger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { config } from '@/config';
import { join, extname } from 'path';
import { existsSync } from 'fs';

/**
 * Application entry point.
 *
 * Boots the NestJS server with:
 *  - Fastify HTTP adapter (default driver)
 *  - Pino structured logging
 *  - Global validation pipe (transform + whitelist)
 *  - Global API prefix (e.g. /api/v1)
 *  - CORS with configurable origins
 *  - Swagger UI (dev/staging only)
 *  - Graceful shutdown hooks
 */
async function bootstrap(): Promise<void> {
  const log = new Logger('Bootstrap');
  log.log('Starting bootstrap...');
  const adapter = new FastifyAdapter({
    logger: false,
    bodyLimit: config.security.maxUploadBytes,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });
  log.log('NestFactory.create done');

  // Multipart support for file uploads (payment receipts, avatars, etc.)
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.security.maxUploadBytes },
  });

  // Switch to Pino logger
  app.useLogger(app.get(PinoLogger));

  // ---- Global prefix ----
  if (config.app.globalPrefix) {
    app.setGlobalPrefix(config.app.globalPrefix, {
      exclude: ['health', 'health/ready'],
    });
  }

  // ---- Validation pipe ----
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ---- CORS ----
  app.enableCors({
    origin: config.app.corsOrigins.length > 0 ? config.app.corsOrigins : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    maxAge: 86400,
  });

  // ---- Static files (dashboard + CMS) ----
  // Resolve a public root valid both when running compiled (dist) and uncompiled (src).
  const candidates = [
    join(__dirname, '..', 'public'),
    join(__dirname, '..', '..', 'public'),
    join(process.cwd(), 'public'),
  ];
  const publicRoot = candidates.find((p: string) => existsSync(p)) ?? candidates[0];
  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: '/',
    decorateReply: true,
  });

  // SPA fallback: serve index.html for /dashboard routes (both /dashboard and /dashboard/*)
  const fastifyInstance = app.getHttpAdapter().getInstance();
  fastifyInstance.get('/dashboard', (_req: any, reply: any) => {
    reply.type('text/html').sendFile('dashboard/index.html', publicRoot);
  });
  fastifyInstance.get('/dashboard/*', (_req: any, reply: any) => {
    reply.type('text/html').sendFile('dashboard/index.html', publicRoot);
  });
  // Serve SPA index for unmatched /dashboard paths that accept HTML and aren't static assets
  fastifyInstance.addHook('onRequest', (request: any, reply: any, done: any) => {
    const url = request && request.raw ? request.raw.url : request && (request.url || '');
    const accept = request && request.headers ? request.headers['accept'] || '' : '';
    const isFile = typeof url === 'string' && extname(url) !== '';
    if (
      typeof url === 'string' &&
      url.startsWith('/dashboard') &&
      !isFile &&
      accept.includes('text/html')
    ) {
      reply.type('text/html').sendFile('dashboard/index.html', publicRoot);
      return;
    }
    done();
  });

  // ---- Graceful shutdown ----
  app.enableShutdownHooks();

  // ---- Swagger (non-production) ----
  if (!config.app.isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle(config.app.name)
      .setDescription('Production-ready Telegram VPN Selling Platform API')
      .setVersion(config.app.apiVersion)
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
      .addTag('auth')
      .addTag('users')
      .addTag('wallet')
      .addTag('plans')
      .addTag('orders')
      .addTag('subscriptions')
      .addTag('vpn')
      .addTag('payments')
      .addTag('servers')
      .addTag('panels')
      .addTag('telegram')
      .addTag('notifications')
      .addTag('broadcasts')
      .addTag('admin')
      .addTag('affiliate')
      .addTag('tickets')
      .addTag('education')
      .addTag('analytics')
      .addTag('reports')
      .addTag('settings')
      .addTag('api-keys')
      .addTag('miniapp')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${config.app.globalPrefix}/docs`, app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
    log.log(`📚 Swagger UI available at /${config.app.globalPrefix}/docs`);
  }

  // ---- Start server ----
  await app.listen(config.app.port, config.app.host);

  log.log(
    `🚀 ${config.app.name} running on http://${config.app.host}:${config.app.port}` +
      (config.app.globalPrefix ? `/${config.app.globalPrefix}` : '') +
      ` [${config.app.env}]`,
  );
}

bootstrap().catch((err) => {
  console.error('❌ Failed to bootstrap application', err);
  process.exit(1);
});
