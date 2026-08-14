import { Module } from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import { AffiliateController } from './affiliate.controller';
import { WalletModule } from '../wallet/wallet.module';
import { VpnModule } from '../vpn/vpn.module';

@Module({
  imports: [WalletModule, VpnModule],
  controllers: [AffiliateController],
  providers: [AffiliateService],
  exports: [AffiliateService],
})
export class AffiliateModule {}
