import { Injectable, Logger } from '@nestjs/common';
import type { AuditAction } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';

/**
 * AuditService - records immutable audit entries for sensitive operations.
 * Used by admin actions, auth events, payment operations, etc.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    userId?: bigint;
    action: AuditAction;
    resource: string;
    resourceId?: string | number;
    before?: unknown;
    after?: unknown;
    ip?: string;
    userAgent?: string;
    metadata?: unknown;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: params.userId ?? null,
          action: params.action,
          resource: params.resource,
          resourceId: params.resourceId != null ? String(params.resourceId) : null,
          before: (params.before as object) ?? undefined,
          after: (params.after as object) ?? undefined,
          ip: params.ip ?? null,
          userAgent: params.userAgent ?? null,
          metadata: (params.metadata as object) ?? undefined,
        },
      });
    } catch (err) {
      // Audit failures must never break the primary flow.
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`);
    }
  }
}
