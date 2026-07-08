import { Module } from '@nestjs/common';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramController } from './telegram.controller';
import { BotRuntime } from './bot-runtime';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { PlansModule } from '../plans/plans.module';
import { OrdersModule } from '../orders/orders.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PaymentsModule } from '../payments/payments.module';
import { ServersModule } from '../servers/servers.module';
import { VpnModule } from '../vpn/vpn.module';
import { TicketsModule } from '../tickets/tickets.module';
import { AdminModule } from '../admin/admin.module';
import { SettingsModule } from '../settings/settings.module';
import { PanelsModule } from '../panels/panels.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProxyModule } from '@/common/proxy/proxy.module';
import { LanguageFlow } from './flows/language.flow';
import { BuyFlow } from './flows/buy.flow';
import { TrialFlow } from './flows/trial.flow';
import { VoucherFlow } from './flows/voucher.flow';
import { WalletFlow } from './flows/wallet.flow';
import { SubscriptionsFlow } from './flows/subscriptions.flow';
import { ProfileFlow } from './flows/profile.flow';
import { ReferralFlow } from './flows/referral.flow';
import { SupportFlow } from './flows/support.flow';
import { AdminFlow } from './flows/admin.flow';

@Module({
  imports: [
    AuthModule,
    WalletModule,
    PlansModule,
    OrdersModule,
    SubscriptionsModule,
    PaymentsModule,
    ServersModule,
    VpnModule,
    TicketsModule,
    AdminModule,
    SettingsModule,
    PanelsModule,
    NotificationsModule,
    ProxyModule,
  ],
  controllers: [TelegramController],
  providers: [
    BotRuntime,
    TelegramBotService,
    LanguageFlow,
    BuyFlow,
    TrialFlow,
    VoucherFlow,
    WalletFlow,
    SubscriptionsFlow,
    ProfileFlow,
    ReferralFlow,
    SupportFlow,
    AdminFlow,
  ],
  exports: [TelegramBotService],
})
export class TelegramModule {}
