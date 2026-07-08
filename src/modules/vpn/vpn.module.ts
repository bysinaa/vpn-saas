import { Module, forwardRef } from '@nestjs/common';
import { VpnService } from './vpn.service';
import { VpnController } from './vpn.controller';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PanelsModule } from '../panels/panels.module';

@Module({
  imports: [
    forwardRef(() => SubscriptionsModule),
    PanelsModule,
  ],
  controllers: [VpnController],
  providers: [VpnService],
  exports: [VpnService],
})
export class VpnModule {}
