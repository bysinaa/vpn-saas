import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { BroadcastService } from './broadcast.service';
import { NotificationsController } from './notifications.controller';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { RedisModule } from '@/common/redis/redis.module';
import { ProxyModule } from '@/common/proxy/proxy.module';
import { AuthModule } from '@/modules/auth/auth.module';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    ProxyModule,
    AuthModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, BroadcastService],
  exports: [NotificationsService, BroadcastService],
})
export class NotificationsModule {}
