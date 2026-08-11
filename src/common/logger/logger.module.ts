import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { config } from '@/config';

/**
 * Pino logging module - structured JSON logs in production,
 * pretty-printed in development.
 */
@Global()
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.monitoring.pinoLevel,
        transport: config.monitoring.pinoPretty
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
                singleLine: false,
              },
            }
          : undefined,
        customProps: (req) => ({
          context: 'HTTP',
          userAgent: req.headers['user-agent'],
        }),
        serializers: {
          req(req: Record<string, unknown>) {
            return {
              method: req.method,
              url: req.url,
            };
          },
          res(res: Record<string, unknown>) {
            return { statusCode: res.statusCode };
          },
        },
        autoLogging: {
          ignore: (req) =>
            typeof req.url === 'string' && req.url.startsWith(config.monitoring.healthPath),
        },
      },
    }),
  ],
})
export class AppLoggerModule {}
