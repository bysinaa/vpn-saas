jest.mock('@/config', () => ({ config: { security: { encryptionKey: 'test-key' } } }));
jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('@/common/redis/redis.service', () => ({ RedisService: class RedisService {} }));
jest.mock('@/common/audit/audit.service', () => ({ AuditService: class AuditService {} }));
jest.mock('../subscriptions/subscriptions.service', () => ({
  SubscriptionsService: class SubscriptionsService {},
}));
jest.mock('../vpn/vpn.service', () => ({ VpnService: class VpnService {} }));

import { VouchersService } from './vouchers.service';

const voucher = {
  id: 7n,
  publicId: '11111111-1111-4111-8111-111111111111',
  code: 'TESTCODE10',
  type: 'PLAN',
  amount: null,
  planId: 9n,
  plan: { id: 9n, name: 'Monthly', isEnabled: true },
  trafficLimitGb: null,
  durationDays: null,
  serverGroupId: null,
  deviceLimit: null,
  maxRedemptions: 2,
  redemptions: 1,
  expiresAt: null,
  redeemedById: 3n,
  usedByTelegramId: '3',
  usedByIp: null,
  redeemedAt: new Date(),
  isActive: true,
  createdById: 1n,
  batchId: 'batch',
  note: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function harness(priorUse: object | null = null) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: voucher.id }]),
    voucher: {
      findUnique: jest.fn().mockResolvedValue({
        redemptions: 1,
        maxRedemptions: 2,
        isActive: true,
        expiresAt: null,
      }),
      update: jest.fn().mockResolvedValue({ ...voucher, redemptions: 2, isActive: false }),
    },
    voucherRedemption: {
      findUnique: jest.fn().mockResolvedValue(priorUse),
      create: jest.fn().mockResolvedValue({ id: 1n }),
    },
    subscription: { update: jest.fn().mockResolvedValue({}) },
    subscriptionEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    voucher: { findUnique: jest.fn().mockResolvedValue(voucher) },
    withTransaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const subscriptions = {
    provision: jest.fn().mockResolvedValue({ id: '21', publicId: 'sub-public' }),
  };
  const vpn = { createVpnUserForSubscription: jest.fn().mockResolvedValue(undefined) };
  const service = new VouchersService(
    prisma as any,
    { del: jest.fn() } as any,
    { log: jest.fn() } as any,
    subscriptions as any,
    vpn as any,
  );
  return { service, tx, subscriptions, vpn };
}

describe('VouchersService redemption ledger', () => {
  it('allows each user to consume a multi-use code only once', async () => {
    const h = harness({ id: 10n });

    await expect(
      h.service.redeem(voucher.code, { userId: 3n, telegramId: '3' }),
    ).rejects.toMatchObject({ code: 'VOUCHER_INVALID' });
    expect(h.subscriptions.provision).not.toHaveBeenCalled();
  });

  it('records voucher provenance and disables the code at its total limit', async () => {
    const h = harness();

    await h.service.redeem(voucher.code, { userId: 4n, telegramId: '4' });

    expect(h.tx.voucherRedemption.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ voucherId: 7n, userId: 4n, subscriptionId: 21n }),
    });
    expect(h.tx.subscription.update).toHaveBeenCalledWith({
      where: { id: 21n },
      data: {
        metadata: expect.objectContaining({
          activationSource: 'VOUCHER',
          chargedAmount: '0',
          paymentId: null,
        }),
      },
    });
    expect(h.tx.voucher.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ redemptions: 2, isActive: false }),
      }),
    );
    expect(h.vpn.createVpnUserForSubscription).toHaveBeenCalledWith(21n);
  });
});
