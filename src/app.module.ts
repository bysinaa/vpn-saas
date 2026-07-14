import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { CommonModule } from '@/common/common.module';
import { ConfigModule } from '@/common/config/config.module';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { RedisModule } from '@/common/redis/redis.module';
import { QueueModule } from '@/common/queue/queue.module';
import { AppLoggerModule } from '@/common/logger/logger.module';
import { StorageModule } from '@/common/storage/storage.module';
import { HealthModule } from '@/common/health/health.module';
import { ProxyModule } from '@/common/proxy/proxy.module';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PlansModule } from './modules/plans/plans.module';
import { OrdersModule } from './modules/orders/orders.module';
import { VpnModule } from './modules/vpn/vpn.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ServersModule } from './modules/servers/servers.module';
import { PanelsModule } from './modules/panels/panels.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AdminModule } from './modules/admin/admin.module';
import { AffiliateModule } from './modules/affiliate/affiliate.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { EducationModule } from './modules/education/education.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ApiModule } from './modules/api/api.module';
import { MiniAppModule } from './modules/miniapp/miniapp.module';
import { XuiModule } from './integrations/xui/xui.module';

/**
 * AppModule - root application module.
 *
 * Global infrastructure modules (Prisma, Redis, Queue, Storage, Logger,
 * Health, Common) are @Global() and imported here once. Feature modules
 * are imported in dependency order. Global guards (JwtAuthGuard,
 * AuthorizationGuard) are registered inside AuthModule via APP_GUARD.
 */
@Module({
  imports: [
    // ---- Global infrastructure ----
    AppLoggerModule,
    ConfigModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    StorageModule,
    ProxyModule,
    CommonModule,
    HealthModule,

    // ---- Feature modules ----
    AuthModule,
    UsersModule,
    WalletModule,
    PlansModule,
    SubscriptionsModule,
    OrdersModule,
    VpnModule,
    PaymentsModule,
    ServersModule,
    PanelsModule,
    NotificationsModule,
    AdminModule,
    AffiliateModule,
    TicketsModule,
    EducationModule,
    AnalyticsModule,
    ReportsModule,
    SettingsModule,
    ApiModule,
    TelegramModule,
    MiniAppModule,
    XuiModule,
  ],
  providers: [
    // Global exception filter - uniform JSON error envelope
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
