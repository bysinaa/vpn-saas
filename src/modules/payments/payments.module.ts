import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { DefaultZarinpalGateway } from './gateways/default-zarinpal.gateway';
import { BankCardsService } from './bank-cards.service';
import { CryptoWalletsService } from './crypto-wallets.service';
import { VouchersService } from './vouchers.service';
import { WalletModule } from '../wallet/wallet.module';
import { OrdersModule } from '../orders/orders.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { VpnModule } from '../vpn/vpn.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  PAYMENT_GATEWAYS,
  type IPaymentGateway,
} from './payment-gateway.interface';

function buildGatewayMap(gateways: IPaymentGateway[]): Map<string, IPaymentGateway> {
  const map = new Map<string, IPaymentGateway>();
  for (const g of gateways) map.set(g.code, g);
  return map;
}

@Module({
  imports: [
    WalletModule,
    OrdersModule,
    SubscriptionsModule,
    VpnModule,
    NotificationsModule,
  ],
  controllers: [PaymentsController],
  providers: [
    DefaultZarinpalGateway,
    {
      provide: PAYMENT_GATEWAYS,
      inject: [DefaultZarinpalGateway],
      useFactory: (zarinpal: DefaultZarinpalGateway) =>
        buildGatewayMap([zarinpal]),
    },
    PaymentsService,
    BankCardsService,
    CryptoWalletsService,
    VouchersService,
  ],
  exports: [PaymentsService, BankCardsService, CryptoWalletsService, VouchersService],
})
export class PaymentsModule {}
