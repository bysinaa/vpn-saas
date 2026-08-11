import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

/**
 * Global exception filter producing a uniform JSON error envelope:
 * { success:false, error:{code,message,details}, timestamp, path }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        code = (b.code as string) ?? code;
        message = (b.message as string) ?? exception.message;
        details = b.details ?? details;
      } else {
        message = body as string;
      }
      if (status >= 500) this.logger.error(exception);
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'VALIDATION_ERROR';
      message = 'Validation failed';
      details = exception.flatten();
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'DUPLICATE_ENTITY';
        message = 'A record with this value already exists';
        details = { target: exception.meta?.target };
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'NOT_FOUND';
        message = 'Record not found';
      } else {
        status = HttpStatus.BAD_REQUEST;
        code = 'DATABASE_ERROR';
        message = `Database error (${exception.code})`;
      }
      this.logger.error(`Prisma error: ${exception.code} ${exception.message}`);
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.stack ?? exception.message);
    }

    const response = {
      success: false,
      error: { code, message, ...(details ? { details } : {}) },
      timestamp: new Date().toISOString(),
      path: req?.url,
    };

    if (typeof res.status === 'function') {
      try {
        // Fastify reply exposes `sent` and raw.writableEnded to indicate a response already in-flight.
        // If the response was already started (for example sendFile/streaming), skip sending JSON to avoid
        // "Attempted to send payload of invalid type 'object'" errors.
        const alreadySent =
          (typeof (res as any).sent === 'boolean' && (res as any).sent) ||
          (res && res.raw && typeof res.raw.writableEnded === 'boolean' && res.raw.writableEnded);

        if (alreadySent) {
          this.logger.warn('Response already sent - skipping exception filter response');
          return;
        }

        res.status(status).send(response);
      } catch (sendErr) {
        // Fallback: if Fastify reply send throws (e.g. stream state), attempt to end the raw response
        // with a JSON string. This ensures we don't crash the process when handling unexpected states.
        try {
          if (res && res.raw && typeof res.raw.end === 'function') {
            if (res.raw.setHeader) {
              res.raw.setHeader('content-type', 'application/json; charset=utf-8');
            }
            res.raw.end(JSON.stringify(response));
            return;
          }
        } catch (rawErr) {
          // Last resort: log warning and do nothing — we cannot reliably send a response here.
          this.logger.warn('Failed to send error response via raw reply', rawErr as any);
        }
      }
    }
  }
}
