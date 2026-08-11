import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';

/**
 * CommonModule aggregates cross-cutting global services (audit) so they are
 * available for DI everywhere. Prisma/Redis/Storage/Queue/Logger have their
 * own @Global() modules imported once in AppModule.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class CommonModule {}
