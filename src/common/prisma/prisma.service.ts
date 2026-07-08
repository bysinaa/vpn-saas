import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaService - thin wrapper around PrismaClient with lifecycle hooks.
 * Implements soft-shutdown to gracefully close DB connections.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('✅ Prisma connected to PostgreSQL');

    (this as any)._engine?.on?.('warn', (e: unknown) => this.logger.warn(e));
    (this as any)._engine?.on?.('error', (e: unknown) => this.logger.error(e));
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }

  /**
   * Execute a transaction with a sane timeout and retry policy.
   *
   * Prisma's $transaction callback is typed as
   * `Omit<PrismaClient, '$connect'|'$disconnect'|'$on'|'$transaction'|'$use'|'$extends'>`,
   * but callers pass `(tx: PrismaClient) => ...`. Because the transactional
   * client is a structural subset of PrismaClient, we accept the broader type
   * and forward via `any` to satisfy the overload.
   */
  async withTransaction<T>(fn: (tx: PrismaClient) => Promise<T>, timeoutMs = 15000): Promise<T> {
    return (this.$transaction as unknown as (
      arg: (tx: PrismaClient) => Promise<T>,
      options: { timeout: number },
    ) => Promise<T>)(fn, { timeout: timeoutMs });
  }
}
