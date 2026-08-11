jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('../wallet/wallet.service', () => ({ WalletService: class WalletService {} }));
jest.mock('../plans/plans.service', () => ({ PlansService: class PlansService {} }));
jest.mock('../subscriptions/subscriptions.service', () => ({
  SubscriptionsService: class SubscriptionsService {},
}));
jest.mock('../vpn/vpn.service', () => ({ VpnService: class VpnService {} }));

import { OrdersService } from './orders.service';

function createOrdersHarness(status = 'PENDING') {
  const order = {
    id: 2n,
    publicId: 'order-1',
    userId: 3n,
    status,
    type: 'NEW',
    planId: 6n,
    subscriptionId: null,
    unitPrice: 500n,
    quantity: 1,
    discountAmount: 0n,
    taxAmount: 0n,
    totalAmount: 500n,
    currency: 'IRR',
    paymentMethod: null,
    createdAt: new Date(),
    completedAt: null,
    plan: { id: 6n, name: 'Plan', isTrial: false },
  };
  const subscription = { id: 7n, plan: { name: 'Plan' } };
  let orderStatus = status;
  const tx = {
    order: {
      findUnique: jest.fn().mockImplementation(async () => ({ ...order, status: orderStatus })),
      updateMany: jest.fn().mockImplementation(async () => {
        if (orderStatus !== 'PENDING') return { count: 0 };
        orderStatus = 'COMPLETED';
        return { count: 1 };
      }),
      update: jest.fn().mockImplementation(async ({ data }) => Object.assign(order, data)),
    },
    subscription: { findUnique: jest.fn().mockResolvedValue(subscription) },
    user: { findUnique: jest.fn().mockResolvedValue({ referredById: null }) },
    systemSetting: { findMany: jest.fn().mockResolvedValue([]) },
    wallet: {
      upsert: jest.fn().mockResolvedValue({ id: 8n, balance: 0n }),
      update: jest.fn().mockResolvedValue({ id: 8n, balance: 50n }),
    },
    walletTransaction: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n } }),
      create: jest.fn().mockResolvedValue({}),
    },
    referralLog: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const subscriptions = {
    provisionInTransaction: jest.fn().mockResolvedValue(subscription),
  };
  const prisma = {
    withTransaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  const vpn = {
    createVpnUserForSubscription: jest.fn().mockResolvedValue(undefined),
    selectProvisioningTarget: jest.fn().mockResolvedValue({ panelId: 1n, inboundIds: [1] }),
  };
  const orders = new OrdersService(prisma as any, {} as any, subscriptions as any, vpn as any);

  return { order, orders, prisma, subscriptions, subscription, tx, vpn };
}

describe('OrdersService.completeOrderInTransaction', () => {
  it('creates one subscription when duplicate order completions arrive concurrently', async () => {
    const harness = createOrdersHarness();
    const originalFindUnique = harness.tx.order.findUnique.getMockImplementation()!;
    let releaseReads!: () => void;
    let bothReadsReached!: () => void;
    const readsReleased = new Promise<void>((resolve) => (releaseReads = resolve));
    const bothReads = new Promise<void>((resolve) => (bothReadsReached = resolve));
    let reads = 0;
    harness.tx.order.findUnique.mockImplementation(async () => {
      if (reads < 2) {
        reads += 1;
        if (reads === 2) bothReadsReached();
        await readsReleased; // Both completions see the same pending order before claiming it.
        return { ...harness.order, status: 'PENDING' };
      }
      return originalFindUnique();
    });

    const first = harness.orders.completeOrderInTransaction(harness.tx as any, 2n, 3n);
    const duplicate = harness.orders.completeOrderInTransaction(harness.tx as any, 2n, 3n);
    await bothReads;
    releaseReads();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

    expect(
      [firstResult, duplicateResult].filter((result) => result.provisioningRequired),
    ).toHaveLength(1);
    expect(harness.subscriptions.provisionInTransaction).toHaveBeenCalledTimes(1);
    expect(harness.tx.order.updateMany).toHaveBeenCalledTimes(2);
  });

  it('does not complete a cancelled order', async () => {
    const harness = createOrdersHarness('CANCELLED');

    await expect(
      harness.orders.completeOrderInTransaction(harness.tx as any, 2n, 3n),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(harness.subscriptions.provisionInTransaction).not.toHaveBeenCalled();
  });

  it('credits the referrer once when a referred purchase completes', async () => {
    const harness = createOrdersHarness();
    harness.tx.user.findUnique.mockResolvedValue({ referredById: 9n });
    harness.tx.systemSetting.findMany.mockResolvedValue([
      { key: 'referral.enabled', value: 'true' },
      { key: 'referral.commissionPercent', value: '10' },
      { key: 'referral.maxBonus', value: '5000000' },
    ]);

    await harness.orders.completeOrderInTransaction(harness.tx as any, 2n, 3n);

    expect(harness.tx.wallet.update).toHaveBeenCalledWith({
      where: { id: 8n },
      data: { balance: { increment: 50n } },
    });
    expect(harness.tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'REFERRAL_REWARD',
        amount: 50n,
        orderId: 2n,
        reference: 'referral-order-order-1',
      }),
    });
    expect(harness.tx.referralLog.updateMany).toHaveBeenCalledWith({
      where: { referrerId: 9n, referredId: 3n, status: 'PENDING' },
      data: { status: 'COMPLETED', completedAt: expect.any(Date) },
    });
  });
});

describe('OrdersService.create renewal orders', () => {
  const plan = {
    id: 6n,
    publicId: 'plan-1',
    name: 'Plan',
    type: 'TRAFFIC',
    status: 'ACTIVE',
    isEnabled: true,
    isRenewable: true,
    price: 500n,
    currency: 'IRT',
  };

  it('requires and attaches an owned target subscription', async () => {
    const target = { id: 7n, userId: 3n, planId: 6n, plan };
    const prisma = {
      subscription: { findUnique: jest.fn().mockResolvedValue(target) },
      order: {
        create: jest.fn(async ({ data }) => ({
          ...data,
          id: 2n,
          createdAt: new Date(),
          completedAt: null,
          plan,
        })),
      },
    };
    const plans = {
      getRaw: jest.fn().mockResolvedValue(plan),
      priceMinor: jest.fn().mockReturnValue(500n),
    };
    const service = new OrdersService(prisma as any, plans as any, {} as any, {} as any);

    await service.create({
      userId: 3n,
      planPublicId: plan.publicId,
      type: 'RENEW',
      targetSubscriptionPublicId: 'subscription-1',
    });

    expect(prisma.order.create.mock.calls[0][0].data).toMatchObject({
      type: 'RENEW',
      subscriptionId: 7n,
      status: 'PENDING',
    });
  });

  it('rejects free-form renewal orders without a target subscription', async () => {
    const plans = {
      getRaw: jest.fn().mockResolvedValue(plan),
      priceMinor: jest.fn().mockReturnValue(500n),
    };
    const service = new OrdersService({} as any, plans as any, {} as any, {} as any);

    await expect(
      service.create({ userId: 3n, planPublicId: plan.publicId, type: 'EXTEND' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
