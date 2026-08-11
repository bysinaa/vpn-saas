import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/redis/redis.service';

/**
 * HealthService - readiness checks for DB + Redis (used by k8s/NGINX probes).
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async checkReadiness(): Promise<{
    status: 'ok' | 'degraded' | 'down';
    checks: Record<string, { status: string; latencyMs?: number; error?: string }>;
    timestamp: string;
  }> {
    const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

    // Postgres
    try {
      const start = Date.now();
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'up', latencyMs: Date.now() - start };
    } catch (err) {
      checks.database = { status: 'down', error: (err as Error).message };
    }

    // Redis
    try {
      const start = Date.now();
      const pong = await this.redis.getClient().ping();
      checks.redis = { status: pong === 'PONG' ? 'up' : 'down', latencyMs: Date.now() - start };
    } catch (err) {
      checks.redis = { status: 'down', error: (err as Error).message };
    }

    const allUp = Object.values(checks).every((c) => c.status === 'up');
    return {
      status: allUp ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  }
}
