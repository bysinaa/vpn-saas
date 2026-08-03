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
    },
    subscription: { findUnique: jest.fn().mockResolvedValue(subscription) },
  };
  const subscriptions = {
    provisionInTransaction: jest.fn().mockResolvedValue(subscription),
  };
  const prisma = {
    withTransaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const vpn = {
    createVpnUserForSubscription: jest.fn().mockResolvedValue(undefined),
    selectProvisioningTarget: jest.fn().mockResolvedValue({ panelId: 1n, inboundIds: [1] }),
  };
  const orders = new OrdersService(prisma as any, {} as any, {} as any, subscriptions as any, vpn as any);

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

    expect([firstResult, duplicateResult].filter((result) => result.provisioningRequired)).toHaveLength(1);
    expect(harness.subscriptions.provisionInTransaction).toHaveBeenCalledTimes(1);
    expect(harness.tx.order.updateMany).toHaveBeenCalledTimes(2);
  });

  it('runs panel provisioning only after the completion transaction commits', async () => {
    const harness = createOrdersHarness();
    let committed = false;
    harness.prisma.withTransaction.mockImplementationOnce(async (callback: any) => {
      const result = await callback(harness.tx);
      committed = true;
      return result;
    });
    harness.vpn.createVpnUserForSubscription.mockImplementation(async () => {
      expect(committed).toBe(true);
    });

    await harness.orders.completeOrder(2n, 3n);

    expect(harness.vpn.createVpnUserForSubscription).toHaveBeenCalledTimes(1);
  });
});
