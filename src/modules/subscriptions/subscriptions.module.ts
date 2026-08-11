import { Module, forwardRef } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { VpnModule } from '../vpn/vpn.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [forwardRef(() => VpnModule), WalletModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
