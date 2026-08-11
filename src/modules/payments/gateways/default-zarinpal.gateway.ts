import { Inject, Injectable } from '@nestjs/common';
import { config } from '@/config';
import type { IPaymentGateway, InitiateResult, VerifyResult } from '../payment-gateway.interface';
import { BusinessException } from '@/common/exceptions/business.exception';
import { SettingsService } from '@/modules/settings/settings.service';

type ZarinpalResponse = { data?: { code?: number; authority?: string; ref_id?: number | string }; errors?: Array<{ code?: number }> };
type GatewayHttpClient = { proxyFetch(url: string, init: Record<string, unknown>): Promise<{ ok: boolean; json(): Promise<unknown> }> };

const REQUEST_PATH = '/pg/v4/payment/request.json';
const VERIFY_PATH = '/pg/v4/payment/verify.json';
// NOTE: must stay a relative path. TypeScript rewrites the `@/` alias in
// `import` statements but not inside a literal require(), so an aliased
// path here survives into dist/ and fails to resolve at runtime.
const ProxyHttpServiceToken = require('../../../common/proxy/proxy-http.service').ProxyHttpService;

@Injectable()
export class DefaultZarinpalGateway implements IPaymentGateway {
  readonly code = 'zarinpal';

  constructor(
    @Inject(ProxyHttpServiceToken) private readonly proxy: GatewayHttpClient,
    private readonly settings: SettingsService,
  ) {}

  async isEnabled(): Promise<boolean> {
    return this.settings.getValue<boolean>('gateway.default.enabled', true);
  }

  async initiate(params: {
    paymentId: bigint;
    amountToman: bigint;
    currency: string;
    description: string;
    callbackUrl: string;
    userPublicId: string;
  }): Promise<InitiateResult> {
    if (params.currency !== 'IRT' || params.amountToman <= 0n) {
      throw BusinessException.conflict('Online payments require a positive IRT toman amount');
    }
    if (!(await this.isEnabled())) throw BusinessException.conflict('Online gateway is disabled');
    const merchantId = await this.merchantId();
    const json = await this.post(REQUEST_PATH, {
      merchant_id: merchantId,
      amount: Number(params.amountToman),
      currency: 'IRT',
      description: params.description,
      callback_url: params.callbackUrl,
      metadata: { order_id: params.userPublicId },
    });
    if (json.data?.code !== 100 || !json.data.authority) throw this.gatewayError(json);
    return {
      paymentPublicId: params.paymentId.toString(),
      gatewayTransactionId: json.data.authority,
      redirectUrl: `${await this.baseUrl()}/pg/StartPay/${json.data.authority}`,
    };
  }

  async verify(params: { gatewayTransactionId: string; paymentId: bigint; amountToman: bigint }): Promise<VerifyResult> {
    const json = await this.post(VERIFY_PATH, {
      merchant_id: await this.merchantId(),
      amount: Number(params.amountToman),
      authority: params.gatewayTransactionId,
    }, true);
    const code = json.data?.code;
    if (code === 100 || code === 101) {
      return { status: 'CONFIRMED', reference: json.data?.ref_id?.toString(), verificationCode: code };
    }
    throw this.gatewayError(json);
  }

  private async baseUrl(): Promise<string> {
    const sandbox = await this.settings.getValue<boolean>(
      'gateway.default.sandbox',
      config.payments.online.sandbox,
    );
    return sandbox ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com';
  }

  private async merchantId(): Promise<string> {
    const stored = await this.settings.getValue<string>('gateway.default.merchantId', '');
    const merchantId = stored.trim() || config.payments.online.merchantId;
    if (!merchantId) throw BusinessException.conflict('Online gateway is not configured');
    return merchantId;
  }

  private async post(path: string, body: Record<string, unknown>, retryTransport = false): Promise<ZarinpalResponse> {
    for (let attempt = 0; attempt < (retryTransport ? 2 : 1); attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await this.proxy.proxyFetch(`${await this.baseUrl()}${path}`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) throw BusinessException.conflict('Payment gateway is unavailable');
        const json = await response.json() as ZarinpalResponse;
        if (!json || typeof json !== 'object') throw BusinessException.conflict('Payment gateway returned an invalid response');
        return json;
      } catch (error) {
        if (error instanceof BusinessException) throw error;
        if (attempt + 1 < (retryTransport ? 2 : 1)) continue; // verify is idempotent (100/101)
        throw BusinessException.conflict('Payment gateway is temporarily unavailable');
      } finally {
        clearTimeout(timeout);
      }
    }
    throw BusinessException.conflict('Payment gateway is temporarily unavailable');
  }

  private gatewayError(json: ZarinpalResponse): BusinessException {
    const code = json.data?.code ?? json.errors?.[0]?.code;
    if (code === -12) return new BusinessException('TOO_MANY_REQUESTS', 'Payment gateway is temporarily unavailable', 429);
    if ([-4, -50, -51, -53, -54, -55].includes(code ?? 0)) return new BusinessException('PAYMENT_REJECTED', 'Payment verification was rejected');
    return BusinessException.conflict('Payment gateway rejected the request');
  }
}
