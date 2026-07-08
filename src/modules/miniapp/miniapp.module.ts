import { Module } from '@nestjs/common';
import { MiniAppService } from './miniapp.service';
import { MiniAppController } from './miniapp.controller';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';
import { PlansModule } from '../plans/plans.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [
    AuthModule,
    WalletModule,
    PlansModule,
    SubscriptionsModule,
    OrdersModule,
  ],
  controllers: [MiniAppController],
  providers: [MiniAppService],
  exports: [MiniAppService],
})
export class MiniAppModule {}
