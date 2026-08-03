jest.mock('@/config', () => ({ config: { payments: { online: { merchantId: 'merchant-test', sandbox: false } } } }));
jest.mock('@/common/proxy/proxy-http.service', () => ({ ProxyHttpService: class {} }));

import { BusinessException } from '@/common/exceptions/business.exception';
import { config } from '@/config';
import { DefaultZarinpalGateway } from './default-zarinpal.gateway';

const response = (body: unknown, ok = true) => ({ ok, json: jest.fn().mockResolvedValue(body) });

describe('DefaultZarinpalGateway official v4 contract', () => {
  const proxy = { proxyFetch: jest.fn() };
  const gateway = new DefaultZarinpalGateway(proxy as any);

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(config.payments.online, { merchantId: 'merchant-test', sandbox: false });
  });

  it('requests IRT toman exactly once and returns the official StartPay URL', async () => {
    proxy.proxyFetch.mockResolvedValue(response({ data: { code: 100, authority: 'A-test' } }));
    const result = await gateway.initiate({ paymentId: 1n, amountToman: 125000n, currency: 'IRT', description: 'Order', callbackUrl: 'https://app.test/callback', userPublicId: 'order-1' });
    expect(proxy.proxyFetch).toHaveBeenCalledWith('https://payment.zarinpal.com/pg/v4/payment/request.json', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(proxy.proxyFetch.mock.calls[0][1].body)).toMatchObject({ amount: 125000, currency: 'IRT', metadata: { order_id: 'order-1' } });
    expect(result.redirectUrl).toBe('https://payment.zarinpal.com/pg/StartPay/A-test');
  });

  it('uses the official sandbox host when configured', async () => {
    Object.assign(config.payments.online, { sandbox: true });
    proxy.proxyFetch.mockResolvedValue(response({ data: { code: 100, authority: 'S-test' } }));
    await gateway.initiate({ paymentId: 1n, amountToman: 1n, currency: 'IRT', description: 'Order', callbackUrl: 'https://app.test/callback', userPublicId: 'order-1' });
    expect(proxy.proxyFetch.mock.calls[0][0]).toContain('https://sandbox.zarinpal.com/pg/v4/payment/request.json');
  });

  it('verifies with the exact stored toman amount and accepts 100 and 101', async () => {
    proxy.proxyFetch.mockResolvedValueOnce(response({ data: { code: 100, ref_id: 99 } })).mockResolvedValueOnce(response({ data: { code: 101, ref_id: 99 } }));
    await expect(gateway.verify({ paymentId: 1n, gatewayTransactionId: 'A-test', amountToman: 125000n })).resolves.toMatchObject({ status: 'CONFIRMED', verificationCode: 100, reference: '99' });
    await expect(gateway.verify({ paymentId: 1n, gatewayTransactionId: 'A-test', amountToman: 125000n })).resolves.toMatchObject({ status: 'CONFIRMED', verificationCode: 101 });
    expect(JSON.parse(proxy.proxyFetch.mock.calls[0][1].body)).toMatchObject({ amount: 125000, authority: 'A-test' });
  });

  it('maps amount mismatch and malformed responses to safe domain errors', async () => {
    proxy.proxyFetch.mockResolvedValueOnce(response({ errors: [{ code: -50 }] })).mockResolvedValueOnce(response({ nope: true }));
    await expect(gateway.verify({ paymentId: 1n, gatewayTransactionId: 'A-test', amountToman: 1n })).rejects.toMatchObject({ code: 'PAYMENT_REJECTED' });
    await expect(gateway.initiate({ paymentId: 1n, amountToman: 1n, currency: 'IRT', description: 'Order', callbackUrl: 'https://app.test/callback', userPublicId: 'order-1' })).rejects.toBeInstanceOf(BusinessException);
  });

  it('retries only idempotent verification transport failures and never retries request creation', async () => {
    proxy.proxyFetch.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(response({ data: { code: 100, ref_id: 99 } }));
    await expect(gateway.verify({ paymentId: 1n, gatewayTransactionId: 'A-test', amountToman: 1n })).resolves.toMatchObject({ verificationCode: 100 });
    expect(proxy.proxyFetch).toHaveBeenCalledTimes(2);
    proxy.proxyFetch.mockReset().mockRejectedValueOnce(new Error('timeout'));
    await expect(gateway.initiate({ paymentId: 1n, amountToman: 1n, currency: 'IRT', description: 'Order', callbackUrl: 'https://app.test/callback', userPublicId: 'order-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(proxy.proxyFetch).toHaveBeenCalledTimes(1);
  });
});
