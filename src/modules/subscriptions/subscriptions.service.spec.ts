jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('../vpn/vpn.service', () => ({ VpnService: class VpnService {} }));

import { SubscriptionsService } from './subscriptions.service';

const GB = 1024n * 1024n * 1024n;

describe('SubscriptionsService plan provisioning', () => {
  it('uses the plan byte quota once and calculates a 35-day expiry', async () => {
    let createdData: Record<string, unknown> = {};
    const tx = {
      plan: { findUnique: jest.fn().mockResolvedValue({ id: 2n, type: 'TRAFFIC', trafficLimitGb: 30n, trafficLimitBytes: 30n * GB, durationDays: 35, deviceLimit: 1, isTrial: false }) },
      subscription: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(async ({ data }) => { createdData = data; return { id: 4n, plan: { name: 'Plan' } }; }) },
      subscriptionEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new SubscriptionsService({} as never, {} as never);

    await service.provisionInTransaction({
      userId: 3n, planId: 2n, orderId: 1n, type: 'NEW',
      provisioningTarget: { panelId: 5n, inboundIds: [11, 12] }, tx: tx as never,
    });

    expect(createdData.trafficLimitBytes).toBe(30n * GB);
    expect(createdData.provisioningInboundIds).toEqual([11, 12]);
    expect((createdData.expiresAt as Date).getTime() - (createdData.startsAt as Date).getTime()).toBe(35 * 86_400_000);
  });
});
