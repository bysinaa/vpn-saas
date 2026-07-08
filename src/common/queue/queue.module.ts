import { Global, Module } from '@nestjs/common';
import { config } from '@/config';

/**
 * QueueModule: BullMQ has been disabled because the deployed Redis is
 * version 3.x which is below BullMQ's minimum requirement of 5.0.
 * All queue-based operations (notifications, broadcasts, payments, etc.)
 * have been replaced with direct synchronous calls.
 */
@Global()
@Module({})
export class QueueModule {}
