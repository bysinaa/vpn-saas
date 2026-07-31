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

  const logger = new Logger('Bootstrap');

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
  // Resolve a public root that's valid both when running compiled (dist) and uncompiled (src).
  // Candidate locations:
  //  - dist/public  (when running built code)
  //  - ../public    (when running via ts-node from project root)
  //  - public       (fallback)
  // Use the first existing path.
  // require fs at runtime so this compiles both in ts-node and compiled builds
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  const candidates = [
    join(__dirname, '..', 'public'), // compiled: dist/public or src/public depending on __dirname
    join(__dirname, '..', '..', 'public'), // when __dirname is dist/<something>/src, try one level up
    join(process.cwd(), 'public'), // fallback to project public dir
  ];
  let publicRoot = candidates.find((p: string) => fs.existsSync(p)) ?? candidates[0];
  // Debug: log resolved public root and file existence to help diagnose static file serving issues
  // eslint-disable-next-line no-console
  console.log('[STATIC] resolved publicRoot=', publicRoot);
  // eslint-disable-next-line no-console
  console.log('[STATIC] index exists=', fs.existsSync(join(publicRoot, 'dashboard', 'index.html')));
  // eslint-disable-next-line no-console
  console.log('[STATIC] app.js exists=', fs.existsSync(join(publicRoot, 'dashboard', 'app.js')));
  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: '/',
    decorateReply: true,
  });
 
  // SPA fallback: serve index.html for /dashboard routes (both /dashboard and /dashboard/*)
  const fastifyInstance = app.getHttpAdapter().getInstance();
  // exact /dashboard -> serve index (add a log so we can see if this handler is hit)
  fastifyInstance.get('/dashboard', (_req: any, reply: any) => {
    // lightweight log for debugging
    // eslint-disable-next-line no-console
    console.log('[STATIC] GET /dashboard -> serving dashboard/index.html');
    reply.type('text/html').sendFile('dashboard/index.html', publicRoot);
  });
  // /dashboard/* -> serve index (for client-side routing)
  fastifyInstance.get('/dashboard/*', (_req: any, reply: any) => {
    // eslint-disable-next-line no-console
    console.log('[STATIC] GET /dashboard/* -> serving dashboard/index.html');
    reply.type('text/html').sendFile('dashboard/index.html', publicRoot);
  });
  // Ensure unmatched dashboard paths are served the SPA index as a fallback.
  // Use a lightweight onRequest hook to serve the SPA index only for HTML-like requests
  // and when the path does not point to a static asset (has no file extension).
  fastifyInstance.addHook('onRequest', (request: any, reply: any, done: any) => {
    const url = request && request.raw ? request.raw.url : (request && (request.url || ''));
    const accept = request && request.headers ? (request.headers['accept'] || '') : '';
    const isFile = typeof url === 'string' && extname(url) !== '';
    // Only serve SPA index when URL is under /dashboard, does not look like a file,
    // and the client accepts HTML (prevents intercepting requests for app.js, style.css, etc.).
    if (typeof url === 'string' && url.startsWith('/dashboard') && !isFile && accept.includes('text/html')) {
      // eslint-disable-next-line no-console
      console.log('[STATIC] onRequest hook matched (serving SPA index)', url);
      reply.type('text/html').sendFile('dashboard/index.html', publicRoot);
      return; // do not call done() after sending
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
    logger.log(`📚 Swagger UI available at /${config.app.globalPrefix}/docs`);
  }

  // ---- Start server ----
  await app.listen(config.app.port, config.app.host);

  logger.log(
    `🚀 ${config.app.name} running on http://${config.app.host}:${config.app.port}` +
      (config.app.globalPrefix ? `/${config.app.globalPrefix}` : '') +
      ` [${config.app.env}]`,
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('❌ Failed to bootstrap application', err);
  process.exit(1);
});
