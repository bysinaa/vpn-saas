jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('../vpn/vpn.service', () => ({ VpnService: class VpnService {} }));

import { SubscriptionsService } from './subscriptions.service';

const GB = 1024n * 1024n * 1024n;

describe('SubscriptionsService plan provisioning', () => {
  it('returns the persisted subscription link after XUI provisioning', async () => {
    const created = { id: 4n, plan: { name: 'Trial' } };
    const persisted = {
      ...created,
      publicId: 'sub-1',
      status: 'TRIAL',
      type: 'COMBINATION',
      trafficLimitBytes: 512n * 1024n * 1024n,
      usedTrafficBytes: 0n,
      durationDays: 3,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 3 * 86_400_000),
      deviceLimit: 1,
      activeDevices: 0,
      subscriptionLink: 'https://subscription.test/token',
      isTrial: true,
      planId: 2n,
      createdAt: new Date(),
    };
    const prisma = {
      withTransaction: jest.fn(async (callback) => callback({})),
      subscription: { findUnique: jest.fn().mockResolvedValue(persisted) },
    };
    const vpn = { createVpnUserForSubscription: jest.fn().mockResolvedValue(undefined) };
    const service = new SubscriptionsService(prisma as any, vpn as any);
    jest.spyOn(service, 'provisionInTransaction').mockResolvedValue(created as any);

    const result = await service.provision({
      userId: 3n,
      planId: 2n,
      type: 'NEW',
      isTrial: true,
    });

    expect(vpn.createVpnUserForSubscription).toHaveBeenCalledWith(4n);
    expect(result.subscriptionLink).toBe('https://subscription.test/token');
  });

  it('uses the plan byte quota once and calculates a 35-day expiry', async () => {
    let createdData: Record<string, unknown> = {};
    const tx = {
      plan: {
        findUnique: jest.fn().mockResolvedValue({
          id: 2n,
          type: 'TRAFFIC',
          trafficLimitGb: 30n,
          trafficLimitBytes: 30n * GB,
          durationDays: 35,
          deviceLimit: 1,
          isTrial: false,
        }),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => {
          createdData = data;
          return { id: 4n, plan: { name: 'Plan' } };
        }),
      },
      subscriptionEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new SubscriptionsService({} as never, {} as never);

    await service.provisionInTransaction({
      userId: 3n,
      planId: 2n,
      orderId: 1n,
      type: 'NEW',
      provisioningTarget: { panelId: 5n, inboundIds: [11, 12] },
      tx: tx as never,
    });

    expect(createdData.trafficLimitBytes).toBe(30n * GB);
    expect(createdData.deviceLimit).toBe(1);
    expect(createdData.provisioningInboundIds).toEqual([11, 12]);
    expect(
      (createdData.expiresAt as Date).getTime() - (createdData.startsAt as Date).getTime(),
    ).toBe(35 * 86_400_000);
  });

  it('refreshes renewal quota, duration, device limit, and expiry from the plan', async () => {
    const previousExpiry = new Date(Date.now() + 5 * 86_400_000);
    let updatedData: Record<string, unknown> = {};
    const tx = {
      plan: {
        findUnique: jest.fn().mockResolvedValue({
          id: 2n,
          type: 'TRAFFIC',
          trafficLimitGb: 30n,
          trafficLimitBytes: 30n * GB,
          durationDays: 35,
          deviceLimit: 3,
          isTrial: false,
        }),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: 4n,
          userId: 3n,
          planId: 2n,
          expiresAt: previousExpiry,
          trafficLimitBytes: 10n * GB,
        }),
        update: jest.fn().mockImplementation(async ({ data }) => {
          updatedData = data;
          return { id: 4n, ...data, plan: { name: 'Plan' } };
        }),
      },
      subscriptionEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new SubscriptionsService({} as never, {} as never);

    await service.provisionInTransaction({
      userId: 3n,
      planId: 2n,
      orderId: 10n,
      type: 'RENEW',
      targetSubscriptionId: 4n,
      tx: tx as never,
    });

    expect(updatedData).toMatchObject({
      trafficLimitBytes: 30n * GB,
      durationDays: 35,
      deviceLimit: 3,
      status: 'ACTIVE',
    });
    expect((updatedData.expiresAt as Date).getTime()).toBe(
      previousExpiry.getTime() + 35 * 86_400_000,
    );
  });
});
