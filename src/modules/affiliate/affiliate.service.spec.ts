jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('../wallet/wallet.service', () => ({ WalletService: class WalletService {} }));
jest.mock('../vpn/vpn.service', () => ({ VpnService: class VpnService {} }));

import { AffiliateService } from './affiliate.service';

describe('AffiliateService Telegram traffic rewards', () => {
  const rewardBytes = 1024n ** 3n;

  function harness(status = 'PENDING') {
    const referral = {
      id: 1n,
      referrerId: 10n,
      referredId: 20n,
      status,
      rewardType: 'TRAFFIC',
      referrerReward: rewardBytes,
      referredReward: rewardBytes,
      referrer: { telegramId: '10', firstName: 'Inviter', username: null },
      referred: { telegramId: '20', firstName: 'New user', username: null },
    };
    const tx = {
      referralLog: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      subscription: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 101n,
            userId: 10n,
            trafficLimitBytes: rewardBytes,
            expiresAt: new Date(Date.now() + 86_400_000),
          })
          .mockResolvedValueOnce(null),
        update: jest.fn().mockResolvedValue({ id: 101n }),
        create: jest.fn().mockResolvedValue({ id: 102n }),
      },
      subscriptionEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      referralLog: {
        findFirst: jest.fn().mockResolvedValue(referral),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      plan: {
        findFirst: jest.fn().mockResolvedValue({
          id: 5n,
          type: 'COMBINATION',
          durationDays: 3,
          deviceLimit: 1,
        }),
      },
      subscription: {
        findMany: jest.fn().mockResolvedValue([
          { userId: 10n, subscriptionLink: 'referrer-link' },
          { userId: 20n, subscriptionLink: 'referred-link' },
        ]),
      },
      withTransaction: jest.fn(async (callback) => callback(tx)),
    };
    const vpn = { createVpnUserForSubscription: jest.fn().mockResolvedValue({}) };
    const service = new AffiliateService(prisma as any, {} as any, vpn as any);
    return { service, prisma, tx, vpn };
  }

  it('increments the inviter existing Free Trial and creates only the new user trial', async () => {
    const h = harness();

    const result = await h.service.fulfillTelegramSignupReferral(20n);

    expect(h.tx.subscription.update).toHaveBeenCalledWith({
      where: { id: 101n },
      data: expect.objectContaining({
        trafficLimitBytes: { increment: rewardBytes },
        status: 'TRIAL',
      }),
    });
    expect(h.tx.subscription.create).toHaveBeenCalledTimes(1);
    expect(h.vpn.createVpnUserForSubscription.mock.calls.map((call) => call[0])).toEqual([
      101n,
      102n,
    ]);
    expect(h.prisma.referralLog.updateMany).toHaveBeenCalledWith({
      where: { id: 1n, status: 'COMPLETED' },
      data: { status: 'REWARDED' },
    });
    expect(result?.rewardBytes).toBe(rewardBytes.toString());
  });

  it('does not award or provision an already rewarded referral again', async () => {
    const h = harness('REWARDED');

    await expect(h.service.fulfillTelegramSignupReferral(20n)).resolves.toBeNull();

    expect(h.prisma.withTransaction).not.toHaveBeenCalled();
    expect(h.vpn.createVpnUserForSubscription).not.toHaveBeenCalled();
  });

  it('atomically increments both existing Free Trials without creating a subscription', async () => {
    const h = harness();
    h.tx.subscription.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        id: 101n,
        userId: 10n,
        trafficLimitBytes: rewardBytes,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .mockResolvedValueOnce({
        id: 102n,
        userId: 20n,
        trafficLimitBytes: rewardBytes,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

    await h.service.fulfillTelegramSignupReferral(20n);

    expect(h.tx.subscription.create).not.toHaveBeenCalled();
    expect(h.tx.subscription.update).toHaveBeenCalledTimes(2);
    for (const [, call] of h.tx.subscription.update.mock.calls.entries()) {
      expect(call[0].data.trafficLimitBytes).toEqual({ increment: rewardBytes });
    }
  });
});
