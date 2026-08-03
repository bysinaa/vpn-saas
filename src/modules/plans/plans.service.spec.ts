jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('@/common/redis/redis.service', () => ({ RedisService: class RedisService {} }));

import { PlansService } from './plans.service';
import { PlansSchemas } from './plans.schemas';

const GB = 1024n * 1024n * 1024n;

describe('admin XUI plans', () => {
  it('stores a 30 GB / 35 day plan as bytes, integer toman, IRT, and ALL_ACTIVE', async () => {
    const created = {
      id: 1n, publicId: 'plan-1', name: '30 GB', slug: '30-gb', description: null,
      type: 'TRAFFIC', trafficLimitGb: 30n, trafficLimitBytes: 30n * GB, durationDays: 35,
      deviceLimit: 1, serverLimit: 1, price: 250000n, originalPrice: null, discountPercent: null,
      currency: 'IRT', priority: 2, isVisible: true, countries: [], isTrial: false,
      isRenewable: true, isTransferable: false, allowPause: false, status: 'ACTIVE',
      inboundPolicy: 'ALL_ACTIVE', panelId: null,
    };
    const prisma = {
      plan: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(created) },
    };
    const redis = { del: jest.fn().mockResolvedValue(undefined) };
    const service = new PlansService(prisma as never, redis as never);

    const plan = await service.create({
      name: '30 GB', type: 'TRAFFIC', trafficLimitGb: 30, durationDays: 35,
      price: '250000', currency: 'IRT', priority: 2, inboundPolicy: 'ALL_ACTIVE',
    });

    expect(prisma.plan.create.mock.calls[0][0].data).toMatchObject({
      trafficLimitBytes: 30n * GB, durationDays: 35, price: 250000n, currency: 'IRT', inboundPolicy: 'ALL_ACTIVE',
    });
    expect(plan.trafficLimitBytes).toBe((30n * GB).toString());
  });

  it('rejects fractional toman and non-IRT admin plan input', () => {
    expect(() => PlansSchemas.create.parse({ name: 'Plan', type: 'TRAFFIC', price: '2500.50', currency: 'IRT' })).toThrow();
    expect(() => PlansSchemas.create.parse({ name: 'Plan', type: 'TRAFFIC', price: '2500', currency: 'USD' })).toThrow();
  });
});
