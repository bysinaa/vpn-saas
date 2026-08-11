jest.mock('@/config', () => ({
  config: {
    telegram: { botToken: 'test-token', adminIds: [] },
    superAdmin: { telegramId: '1' },
  },
}));
jest.mock('@/common/proxy/proxy-http.service', () => ({ ProxyHttpService: class ProxyHttpService {} }));

import { BuyFlow } from './buy.flow';

describe('BuyFlow receipt upload', () => {
  it('uploads a private receipt and submits its signed storage location', async () => {
    const runtime = {
      getLocale: jest.fn().mockResolvedValue('en'),
      getSession: jest.fn().mockResolvedValue({
        userId: 7n,
        data: { paymentPublicId: 'payment-1', amount: '1200', currency: 'IRR' },
      }),
      clearState: jest.fn().mockResolvedValue(undefined),
      resetMenu: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      notifyAdminsWithPhoto: jest.fn().mockResolvedValue(undefined),
      translateError: jest.fn((_locale, error) => error.message),
    };
    const payments = { submitReceipt: jest.fn().mockResolvedValue({}) };
    const storage = {
      upload: jest.fn().mockResolvedValue({
        key: 'receipts/7/receipt.jpg',
        url: 'http://minio:9000/signed-private-receipt',
        bucket: 'tazaxy',
        mimeType: 'image/jpeg',
        size: 7,
      }),
    };
    const proxy = {
      proxyFetch: jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('receipt')),
      }),
    };
    const flow = new BuyFlow(
      runtime as any,
      {} as any,
      {} as any,
      payments as any,
      {} as any,
      {} as any,
      {} as any,
      storage as any,
      proxy as any,
      {} as any,
    );
    const ctx = {
      from: { id: 123, first_name: 'Receipt', last_name: 'Owner' },
      telegram: {
        getFile: jest.fn().mockResolvedValue({ file_path: 'photos/receipt.jpg' }),
        sendPhoto: jest.fn(),
      },
    } as any;

    await flow.onReceiptUpload(ctx, 'telegram-photo-id');

    expect(storage.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        body: Buffer.from('receipt'),
        mimeType: 'image/jpeg',
        isPublic: false,
      }),
    );
    expect(payments.submitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7n,
        paymentPublicId: 'payment-1',
        fileKey: 'receipts/7/receipt.jpg',
        fileUrl: 'http://minio:9000/signed-private-receipt',
      }),
    );
    expect(runtime.clearState).toHaveBeenCalledWith('123');
    expect(runtime.notifyAdminsWithPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'telegram-photo-id',
        caption: expect.stringContaining('payment-1'),
        keyboard: expect.objectContaining({ reply_markup: expect.any(Object) }),
      }),
    );
  });
});
