import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestFastifyApplication, FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Logger as PinoLogger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { config } from '@/config';
import { join } from 'path';

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
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    {
      bufferLogs: true,
      logger: ['log', 'error', 'warn', 'debug', 'verbose'],
    },
  );
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
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'public'),
    prefix: '/',
    decorateReply: false,
  });

  // SPA fallback: serve index.html for /dashboard/* routes
  const fastifyInstance = app.getHttpAdapter().getInstance();
  fastifyInstance.get('/dashboard/*', (_req: any, reply: any) => {
    reply.sendFile('dashboard/index.html', join(__dirname, '..', 'public'));
  });

  // ---- Graceful shutdown ----
  app.enableShutdownHooks();

  // ---- Swagger (non-production) ----
  if (!config.app.isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle(config.app.name)
      .setDescription('Production-ready Telegram VPN Selling Platform API')
      .setVersion(config.app.apiVersion)
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'access-token',
      )
      .addApiKey(
        { type: 'apiKey', name: 'X-API-Key', in: 'header' },
        'api-key',
      )
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
