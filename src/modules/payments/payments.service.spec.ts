jest.mock('@/config', () => ({ config: { app: { url: 'https://app.test' }, payments: { online: { callbackUrl: '' } } } }));
jest.mock('../wallet/wallet.service', () => ({ WalletService: class {} }));
jest.mock('../orders/orders.service', () => ({ OrdersService: class {} }));
jest.mock('@/common/audit/audit.service', () => ({ AuditService: class {} }));
jest.mock('../notifications/notifications.service', () => ({ NotificationsService: class {} }));

import { PaymentsService } from './payments.service';

function harness() {
  const payment: any = { id: 1n, publicId: 'payment-1', orderId: 2n, userId: 3n, method: 'ONLINE', status: 'PENDING', amount: 125000n, currency: 'IRT', gateway: 'zarinpal', gatewayRef: 'A-stored', metadata: null, confirmedAt: null, createdAt: new Date(), order: { publicId: 'order-1' } };
  const tx = { payment: { updateMany: jest.fn(async ({ data }: any) => { if (payment.status === 'PENDING') { Object.assign(payment, data); return { count: 1 }; } return { count: 0 }; }) } };
  const prisma: any = {
    payment: {
      findFirst: jest.fn(async ({ where }: any) => where.gatewayRef === 'A-stored' ? payment : null),
      findUniqueOrThrow: jest.fn(async () => payment),
      findUnique: jest.fn(async () => payment),
      updateMany: jest.fn(async ({ data }: any) => { Object.assign(payment, data); return { count: 1 }; }),
      update: jest.fn(async ({ data }: any) => Object.assign(payment, data)),
    },
    withTransaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const gateway = { code: 'zarinpal', verify: jest.fn() };
  const orders = { completeOrder: jest.fn() };
  const service = new PaymentsService(prisma, { credit: jest.fn() } as any, orders as any, { log: jest.fn() } as any, { send: jest.fn() } as any, new Map([['zarinpal', gateway]]) as any);
  return { service, payment, prisma, gateway, orders };
}

describe('PaymentsService Zarinpal callback settlement', () => {
  it('does not verify NOK callbacks', async () => {
    const h = harness();
    await h.service.handleOnlineCallback('A-stored', 'NOK');
    expect(h.gateway.verify).not.toHaveBeenCalled();
    expect(h.payment.status).toBe('CANCELLED');
    expect(h.payment.gatewayStatus).toBe('NOK');
  });

  it('rejects an authority not stored for the payment', async () => {
    const h = harness();
    await expect(h.service.handleOnlineCallback('A-other', 'OK')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.gateway.verify).not.toHaveBeenCalled();
  });

  it('settles code 100 once and code 101 idempotently without duplicate completion', async () => {
    const h = harness();
    h.gateway.verify.mockResolvedValueOnce({ status: 'CONFIRMED', verificationCode: 100, reference: '99' }).mockResolvedValueOnce({ status: 'CONFIRMED', verificationCode: 101, reference: '99' });
    await h.service.handleOnlineCallback('A-stored', 'OK');
    await h.service.handleOnlineCallback('A-stored', 'OK');
    expect(h.gateway.verify).toHaveBeenNthCalledWith(1, { gatewayTransactionId: 'A-stored', paymentId: 1n, amountToman: 125000n });
    expect(h.orders.completeOrder).toHaveBeenCalledTimes(1);
    expect(h.payment.gatewayVerifyCode).toBe(101);
    expect(h.payment.gatewayRefId).toBe('99');
  });
});
