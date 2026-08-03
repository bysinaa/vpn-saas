jest.mock('@/config', () => ({ config: { superAdmin: { telegramId: '1' } } }));
jest.mock('../bot-runtime', () => ({ BotRuntime: class BotRuntime {} }));
jest.mock('../../admin/admin.service', () => ({ AdminService: class AdminService {} }));
jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('../../payments/bank-cards.service', () => ({ BankCardsService: class BankCardsService {} }));
jest.mock('../../payments/crypto-wallets.service', () => ({ CryptoWalletsService: class CryptoWalletsService {} }));
jest.mock('../../payments/vouchers.service', () => ({ VouchersService: class VouchersService {} }));
jest.mock('../../plans/plans.service', () => ({ PlansService: class PlansService {} }));
jest.mock('../../settings/settings.service', () => ({ SettingsService: class SettingsService {} }));
jest.mock('../../panels/panels.service', () => ({ PanelsService: class PanelsService {} }));
jest.mock('../../notifications/broadcast.service', () => ({ BroadcastService: class BroadcastService {} }));
jest.mock('../../vpn/vpn.service', () => ({ VpnService: class VpnService {} }));
jest.mock('../../orders/orders.service', () => ({ OrdersService: class OrdersService {} }));

import { AdminFlow } from './admin.flow';

function createApprovalHarness(status = 'AWAITING_VERIFY') {
  const payment = {
    id: 1n,
    status,
    amount: 500n,
    currency: 'IRR',
    orderId: 2n,
    user: { id: 3n, telegramId: null },
    receipt: { id: 4n },
  };
  let claimed = false;
  const walletUpdate = jest.fn().mockResolvedValue({});
  const tx = {
    payment: {
      updateMany: jest.fn(async () => {
        if (claimed) return { count: 0 };
        claimed = true;
        return { count: 1 };
      }),
    },
    receipt: { update: jest.fn().mockResolvedValue({}) },
    wallet: {
      findFirst: jest.fn().mockResolvedValue({ id: 5n }),
      update: walletUpdate,
    },
  };
  const prisma = {
    payment: { findUnique: jest.fn().mockResolvedValue(payment) },
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    vpnUser: { findUnique: jest.fn().mockResolvedValue(null) },
    user: { findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN', telegramId: '1' }) },
  };
  const runtime = {
    getLocale: jest.fn().mockResolvedValue('en'),
    getSession: jest.fn().mockResolvedValue({ userId: 3n }),
  };
  const vpn = { createVpnUserForSubscription: jest.fn().mockResolvedValue(undefined) };
  const orders = {
    completeOrderInTransaction: jest.fn().mockResolvedValue({
      order: {},
      subscription: { id: 7n, plan: { name: 'Plan', durationDays: null } },
      provisioningRequired: true,
    }),
  };
  const flow = new AdminFlow(
    runtime as any,
    {} as any,
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    vpn as any,
    orders as any,
  );
  const context = { from: { id: 1 }, telegram: { sendMessage: jest.fn().mockResolvedValue({}) } } as any;

  return { context, flow, payment, prisma, tx, vpn, orders, walletUpdate };
}

describe('AdminFlow.approveReceipt', () => {
  it('credits a card receipt only once when duplicate approvals arrive concurrently', async () => {
    let releaseReads!: () => void;
    let bothReadsReached!: () => void;
    const readsReleased = new Promise<void>((resolve) => (releaseReads = resolve));
    const bothReads = new Promise<void>((resolve) => (bothReadsReached = resolve));
    let reads = 0;
    const harness = createApprovalHarness();
    harness.prisma.payment.findUnique.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) bothReadsReached();
      await readsReleased;
      return harness.payment;
    });

    const first = harness.flow.approveReceipt(harness.context, 'payment-1');
    const second = harness.flow.approveReceipt(harness.context, 'payment-1');
    await bothReads;
    releaseReads(); // Both approvals now proceed from the same pending read.
    await Promise.all([first, second]);

    expect(harness.walletUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not repeat side effects for an already-approved card receipt', async () => {
    const harness = createApprovalHarness('CONFIRMED');

    await harness.flow.approveReceipt(harness.context, 'payment-1');

    expect(harness.walletUpdate).not.toHaveBeenCalled();
    expect(harness.orders.completeOrderInTransaction).not.toHaveBeenCalled();
    expect(harness.vpn.createVpnUserForSubscription).not.toHaveBeenCalled();
  });

  it('uses the canonical completion operation for an approved card receipt', async () => {
    const harness = createApprovalHarness();

    await harness.flow.approveReceipt(harness.context, 'payment-1');

    expect(harness.orders.completeOrderInTransaction).toHaveBeenCalledTimes(1);
    expect(harness.orders.completeOrderInTransaction).toHaveBeenCalledWith(
      harness.tx,
      2n,
      3n,
    );
  });

  it('does not provision when the approval transaction fails', async () => {
    const harness = createApprovalHarness();
    harness.prisma.$transaction.mockRejectedValueOnce(new Error('rollback'));

    await expect(harness.flow.approveReceipt(harness.context, 'payment-1')).rejects.toThrow(
      'rollback',
    );

    expect(harness.vpn.createVpnUserForSubscription).not.toHaveBeenCalled();
  });

  it('provisions only after a successful approval transaction commits', async () => {
    const harness = createApprovalHarness();
    let committed = false;
    harness.prisma.$transaction.mockImplementationOnce(async (callback: any) => {
      const result = await callback(harness.tx);
      committed = true;
      return result;
    });
    harness.vpn.createVpnUserForSubscription.mockImplementation(async () => {
      expect(committed).toBe(true);
    });

    await harness.flow.approveReceipt(harness.context, 'payment-1');

    expect(harness.vpn.createVpnUserForSubscription).toHaveBeenCalledTimes(1);
  });
});
