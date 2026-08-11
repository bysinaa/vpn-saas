jest.mock('@/config', () => ({
  config: { app: { url: 'https://app.test' }, payments: { online: { callbackUrl: '' } } },
}));
jest.mock('../wallet/wallet.service', () => ({ WalletService: class {} }));
jest.mock('../orders/orders.service', () => ({ OrdersService: class {} }));
jest.mock('../vpn/vpn.service', () => ({ VpnService: class {} }));
jest.mock('@/common/audit/audit.service', () => ({ AuditService: class {} }));
jest.mock('../notifications/notifications.service', () => ({ NotificationsService: class {} }));

import { PaymentsService } from './payments.service';

const ORDER_PUBLIC_ID = '11111111-1111-4111-8111-111111111111';

function harness(options: { orderId?: bigint | null; status?: string } = {}) {
  const payment: any = {
    id: 1n,
    publicId: 'payment-1',
    orderId: options.orderId === undefined ? 2n : options.orderId,
    userId: 3n,
    method: 'ONLINE',
    status: options.status ?? 'PENDING',
    amount: 125000n,
    currency: 'IRT',
    gateway: 'zarinpal',
    gatewayRef: 'A-stored',
    metadata: null,
    confirmedAt: null,
    createdAt: new Date(),
    order: options.orderId === null ? null : { publicId: ORDER_PUBLIC_ID },
  };
  const order: any = {
    id: 2n,
    publicId: ORDER_PUBLIC_ID,
    userId: 3n,
    planId: 4n,
    type: 'NEW',
    status: 'PENDING',
    totalAmount: 125000n,
    currency: 'IRT',
    plan: { id: 4n, name: 'Plan' },
  };
  const receipt: any = {
    id: 5n,
    publicId: 'receipt-1',
    paymentId: payment.id,
    status: 'PENDING',
    userId: payment.userId,
    payerName: 'Payer',
    cardNumber: null,
    fileKey: 'receipt.jpg',
    amount: payment.amount,
    verifiedById: null,
    verifiedAt: null,
    rejectionReason: null,
    createdAt: new Date(),
    payment,
  };
  let walletTransaction: any = null;
  let walletBalance = 0n;
  let walletDebits = 0;
  let failOrderCompletion = false;
  const sentEvents = new Set<string>();
  const subscription: any = {
    id: 7n,
    publicId: 'subscription-1',
    subscriptionLink: 'https://panel.test/sub/token',
    vpnUser: { subLink: 'https://panel.test/sub/token' },
    plan: { name: 'Plan' },
  };

  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    payment: {
      findUniqueOrThrow: jest.fn(async () => payment),
      updateMany: jest.fn(async ({ data }: any) => {
        if (!['INITIATED', 'PENDING', 'AWAITING_VERIFY'].includes(payment.status)) {
          return { count: 0 };
        }
        Object.assign(payment, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => Object.assign(payment, data)),
      create: jest.fn(async ({ data }: any) => {
        Object.assign(payment, data, { id: 1n, order: { publicId: order.publicId } });
        return payment;
      }),
    },
    order: { findUnique: jest.fn(async () => order) },
    walletTransaction: { findUnique: jest.fn(async () => walletTransaction) },
    receipt: {
      findUnique: jest.fn(async () => receipt),
      findUniqueOrThrow: jest.fn(async () => receipt),
      updateMany: jest.fn(async ({ data }: any) => {
        if (receipt.status !== 'PENDING') return { count: 0 };
        Object.assign(receipt, data);
        return { count: 1 };
      }),
    },
  };
  const prisma: any = {
    subscription: {
      findUnique: jest.fn(async () => subscription),
      findUniqueOrThrow: jest.fn(async () => subscription),
    },
    notification: {
      findFirst: jest.fn(async ({ where }: any) =>
        sentEvents.has(where.event) ? { id: 1n, event: where.event, status: 'SENT' } : null,
      ),
    },
    payment: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.gatewayRef === 'A-stored' ? payment : null,
      ),
      findUniqueOrThrow: jest.fn(async () => payment),
      updateMany: jest.fn(async ({ data }: any) => {
        if (!['INITIATED', 'PENDING', 'AWAITING_VERIFY'].includes(payment.status)) {
          return { count: 0 };
        }
        Object.assign(payment, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => Object.assign(payment, data)),
      create: jest.fn(async ({ data }: any) => Object.assign(payment, data, { id: 1n })),
    },
    cryptoPayment: {
      create: jest.fn(async ({ data }: any) => ({ id: 8n, ...data })),
    },
    withTransaction: jest.fn(async (fn: any) => {
      const snapshot = {
        payment: { ...payment },
        orderStatus: order.status,
        receipt: { ...receipt },
        walletTransaction,
        walletBalance,
        walletDebits,
      };
      try {
        return await fn(tx);
      } catch (error) {
        Object.assign(payment, snapshot.payment);
        order.status = snapshot.orderStatus;
        Object.assign(receipt, snapshot.receipt);
        walletTransaction = snapshot.walletTransaction;
        walletBalance = snapshot.walletBalance;
        walletDebits = snapshot.walletDebits;
        throw error;
      }
    }),
  };
  const gateway = {
    code: 'zarinpal',
    isEnabled: jest.fn().mockResolvedValue(true),
    initiate: jest.fn().mockResolvedValue({
      gatewayTransactionId: 'A-created',
      redirectUrl: 'https://sandbox.zarinpal.com/pg/StartPay/A-created',
    }),
    verify: jest.fn(),
  };
  const orders = {
    findOne: jest.fn(async () => ({ ...order, id: order.id.toString(), totalAmount: order.totalAmount.toString() })),
    completeOrderInTransaction: jest.fn(async () => {
      if (failOrderCompletion) throw new Error('subscription write failed');
      if (order.status === 'COMPLETED') {
        return {
          order: { id: order.id.toString(), status: order.status },
          subscription: { id: 7n },
          provisioningRequired: false,
        };
      }
      order.status = 'COMPLETED';
      return {
        order: { id: order.id.toString(), status: order.status },
        subscription: { id: 7n },
        provisioningRequired: true,
      };
    }),
  };
  const wallet = {
    mutateBalanceInTransaction: jest.fn(async (_tx: any, input: any) => {
      if (walletTransaction) return walletTransaction;
      if (input.direction === 'credit') walletBalance += input.amount;
      else walletDebits += 1;
      walletTransaction = { id: 9n, paymentId: input.paymentId };
      return walletTransaction;
    }),
  };
  const vpn = { createVpnUserForSubscription: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    send: jest.fn().mockImplementation(async ({ type }: any) => {
      sentEvents.add(type);
    }),
  };
  const bankCards = { getDepositCard: jest.fn().mockResolvedValue({ publicId: 'card-1' }) };
  const cryptoWallets = {
    getDefault: jest.fn().mockResolvedValue({
      publicId: 'crypto-1',
      address: 'T-address',
      network: 'TRC20',
    }),
  };
  const service = new PaymentsService(
    prisma,
    wallet as any,
    orders as any,
    vpn as any,
    audit as any,
    notifications as any,
    new Map([['zarinpal', gateway]]) as any,
    { getValue: jest.fn(async (_key: string, fallback: unknown) => fallback) } as any,
    bankCards as any,
    cryptoWallets as any,
  );

  return {
    service,
    payment,
    order,
    receipt,
    prisma,
    gateway,
    orders,
    wallet,
    vpn,
    audit,
    notifications,
    bankCards,
    cryptoWallets,
    tx,
    walletBalance: () => walletBalance,
    walletDebits: () => walletDebits,
    failOrderCompletion: () => (failOrderCompletion = true),
  };
}

describe('PaymentsService payment destinations', () => {
  it('returns the persisted online gateway URL to the Telegram caller', async () => {
    const h = harness();
    const result = await h.service.initiate({
      userId: 3n,
      orderPublicId: 'order-1',
      method: 'ONLINE',
    });
    expect(result.redirectUrl).toBe('https://sandbox.zarinpal.com/pg/StartPay/A-created');
    expect(h.payment.gatewayRef).toBe('A-created');
  });

  it('uses the active/default crypto wallet for both persistence and Telegram display', async () => {
    const h = harness();
    const result = await h.service.initiate({
      userId: 3n,
      orderPublicId: 'order-1',
      method: 'CRYPTO',
      cryptoCurrency: 'USDT_TRC20',
    });
    expect(h.cryptoWallets.getDefault).toHaveBeenCalledWith('USDT_TRC20');
    expect(h.prisma.cryptoPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ currency: 'USDT_TRC20', address: 'T-address' }),
    });
    expect(result).toMatchObject({ cryptoAddress: 'T-address', cryptoNetwork: 'TRC20' });
  });

  it('does not create a payment when no active card or crypto destination exists', async () => {
    const card = harness();
    card.bankCards.getDepositCard.mockResolvedValueOnce(null);
    await expect(card.service.initiate({ userId: 3n, orderPublicId: 'order-1', method: 'CARD_TO_CARD' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(card.prisma.payment.create).not.toHaveBeenCalled();

    const crypto = harness();
    crypto.cryptoWallets.getDefault.mockResolvedValueOnce(null);
    await expect(crypto.service.initiate({ userId: 3n, orderPublicId: 'order-1', method: 'CRYPTO', cryptoCurrency: 'TON' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(crypto.prisma.payment.create).not.toHaveBeenCalled();
  });
});

describe('PaymentsService canonical settlement', () => {
  it('does not verify or complete NOK callbacks', async () => {
    const h = harness();
    await h.service.handleOnlineCallback('A-stored', 'NOK');
    expect(h.gateway.verify).not.toHaveBeenCalled();
    expect(h.orders.completeOrderInTransaction).not.toHaveBeenCalled();
    expect(h.payment.status).toBe('CANCELLED');
  });

  it('settles gateway code 100 once and accepts code 101 idempotently', async () => {
    const h = harness();
    h.gateway.verify
      .mockResolvedValueOnce({ status: 'CONFIRMED', verificationCode: 100, reference: '99' })
      .mockResolvedValueOnce({ status: 'CONFIRMED', verificationCode: 101, reference: '99' });

    await h.service.handleOnlineCallback('A-stored', 'OK');
    await h.service.handleOnlineCallback('A-stored', 'OK');

    expect(h.orders.completeOrderInTransaction).toHaveBeenCalledTimes(2);
    expect(h.vpn.createVpnUserForSubscription).toHaveBeenCalledTimes(2);
    expect(h.wallet.mutateBalanceInTransaction).not.toHaveBeenCalled();
    expect(h.payment.gatewayVerifyCode).toBe(101);
    expect(h.notifications.send).toHaveBeenCalledTimes(1);
    expect(h.notifications.send.mock.calls[0][0].body).toContain('https://panel.test/sub/token');
  });

  it('never completes an order for a failed gateway verification', async () => {
    const h = harness();
    h.gateway.verify.mockResolvedValue({ status: 'FAILED' });
    await h.service.handleOnlineCallback('A-stored', 'OK');
    expect(h.payment.status).toBe('REJECTED');
    expect(h.orders.completeOrderInTransaction).not.toHaveBeenCalled();
  });

  it('does not downgrade an already-confirmed payment after a later failed verification', async () => {
    const h = harness({ status: 'CONFIRMED' });
    h.gateway.verify.mockResolvedValue({ status: 'FAILED' });
    await h.service.handleOnlineCallback('A-stored', 'OK');
    expect(h.payment.status).toBe('CONFIRMED');
  });

  it('credits a standalone wallet top-up exactly once', async () => {
    const h = harness({ orderId: null });
    await h.service.confirmPayment(1n);
    await h.service.confirmPayment(1n);
    expect(h.walletBalance()).toBe(125000n);
    expect(h.audit.log).toHaveBeenCalledTimes(1);
    expect(h.orders.completeOrderInTransaction).not.toHaveBeenCalled();
  });

  it('approves an order receipt once without crediting wallet', async () => {
    const h = harness();
    const input = { adminId: 8n, receiptPublicId: 'receipt-1', status: 'APPROVED' as const };
    await h.service.verifyReceipt(input);
    await h.service.verifyReceipt(input);
    expect(h.orders.completeOrderInTransaction).toHaveBeenCalledTimes(2);
    expect(h.wallet.mutateBalanceInTransaction).not.toHaveBeenCalled();
    expect(h.vpn.createVpnUserForSubscription).toHaveBeenCalledTimes(2);
    expect(h.notifications.send).toHaveBeenCalledTimes(1);
  });

  it('rolls confirmation back when order completion fails so retry remains possible', async () => {
    const h = harness();
    h.failOrderCompletion();
    await expect(h.service.confirmPayment(1n)).rejects.toThrow('subscription write failed');
    expect(h.payment.status).toBe('PENDING');
    expect(h.vpn.createVpnUserForSubscription).not.toHaveBeenCalled();
  });

  it('keeps the committed payment confirmed but reports post-commit provisioning failure', async () => {
    const h = harness();
    h.vpn.createVpnUserForSubscription.mockRejectedValueOnce(
      new Error('VPN provisioning is pending and can be retried'),
    );

    await expect(h.service.confirmPayment(1n)).rejects.toThrow('provisioning is pending');

    expect(h.payment.status).toBe('CONFIRMED');
    expect(h.order.status).toBe('COMPLETED');
    expect(h.audit.log).toHaveBeenCalledTimes(1);

    await expect(h.service.confirmPayment(1n)).resolves.toBeUndefined();
    expect(h.vpn.createVpnUserForSubscription).toHaveBeenCalledTimes(2);
  });

  it('debits a wallet order once and rejects a repeated payment attempt', async () => {
    const h = harness();
    const result = await h.service.payOrderWithWallet(ORDER_PUBLIC_ID, 3n);
    await expect(h.service.payOrderWithWallet(ORDER_PUBLIC_ID, 3n)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(h.walletDebits()).toBe(1);
    expect(h.payment.method).toBe('WALLET');
    expect(h.orders.completeOrderInTransaction).toHaveBeenCalledTimes(1);
    expect(result.subscription.subscriptionLink).toBe('https://panel.test/sub/token');
  });

  it('returns the normal not-found error before SQL for a malformed order public ID', async () => {
    const h = harness();

    await expect(h.service.payOrderWithWallet('not-a-uuid', 3n)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns the normal not-found error for a valid nonexistent order public ID', async () => {
    const h = harness();
    h.tx.order.findUnique.mockResolvedValueOnce(null);

    await expect(h.service.payOrderWithWallet(ORDER_PUBLIC_ID, 3n)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
