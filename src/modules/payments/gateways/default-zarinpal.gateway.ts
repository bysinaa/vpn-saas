import { Injectable } from '@nestjs/common';
import { config } from '@/config';
import { ProxyHttpService } from '@/common/proxy/proxy-http.service';
import type {
  IPaymentGateway,
  InitiateResult,
  VerifyResult,
} from '../payment-gateway.interface';
import { BusinessException } from '@/common/exceptions/business.exception';

/**
 * DefaultZarinpalGateway - reference implementation of IPaymentGateway
 * against a Zarinpal-like REST API.
 *
 * All outbound traffic is routed through the centralised SOCKS5 proxy via
 * ProxyHttpService. Swap with the real SDK as needed; the PaymentsService
 * depends only on the interface.
 */
@Injectable()
export class DefaultZarinpalGateway implements IPaymentGateway {
  readonly code = 'zarinpal';

  constructor(private readonly proxy: ProxyHttpService) {}

  async initiate(params: {
    paymentId: bigint;
    amountMinor: bigint;
    currency: string;
    description: string;
    callbackUrl: string;
    userPublicId: string;
  }): Promise<InitiateResult> {
    const merchantId = config.payments.online.merchantId;
    if (!merchantId) {
      throw BusinessException.conflict('Online gateway merchantId not configured');
    }

    const res = await this.proxy.proxyFetch(`${config.payments.online.baseUrl}/pg/v4/payment/request.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_id: merchantId,
        amount: Number(params.amountMinor),
        description: params.description,
        callback_url: params.callbackUrl,
      }),
    });
    const json = (await res.json()) as { data?: { authority?: string; code?: number }; errors?: any };

    const authority = json.data?.authority;
    if (!authority) {
      throw BusinessException.conflict('Gateway initiation failed');
    }

    return {
      paymentPublicId: params.paymentId.toString(),
      gatewayTransactionId: authority,
      redirectUrl: `https://www.zarinpal.com/pg/StartPay/${authority}`,
    };
  }

  async verify(params: {
    gatewayTransactionId: string;
    paymentId: bigint;
  }): Promise<VerifyResult> {
    const merchantId = config.payments.online.merchantId;
    const res = await this.proxy.proxyFetch(`${config.payments.online.baseUrl}/pg/v4/payment/verify.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_id: merchantId,
        authority: params.gatewayTransactionId,
      }),
    });
    const json = (await res.json()) as { data?: { code?: number; ref_id?: string }; errors?: any };

    if (json.data?.code === 100 || json.data?.code === 101) {
      return { status: 'CONFIRMED', reference: json.data.ref_id?.toString() };
    }
    return { status: 'FAILED' };
  }
}
