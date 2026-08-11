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

  it('lists only visible, enabled, active plans', async () => {
    const prisma = {
      plan: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const redis = {
      cached: jest.fn(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load()),
    };
    const service = new PlansService(prisma as never, redis as never);

    await service.listVisible();

    expect(prisma.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isVisible: true, isEnabled: true, status: 'ACTIVE' },
      }),
    );
  });

  it('creates a non-empty slug for Persian-only plan names', async () => {
    const prisma = {
      plan: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 1n,
          publicId: 'plan-1',
          description: null,
          trafficLimitGb: null,
          trafficLimitBytes: null,
          durationDays: 30,
          deviceLimit: 1,
          serverLimit: 1,
          originalPrice: null,
          discountPercent: null,
          countries: [],
          isTrial: false,
          isRenewable: true,
          isTransferable: false,
          allowPause: false,
          status: 'ACTIVE',
          inboundPolicy: 'ALL_ACTIVE',
          panelId: null,
          ...data,
        })),
      },
    };
    const service = new PlansService(
      prisma as never,
      { del: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await service.create({ name: 'پلن ماهانه', type: 'TIME', durationDays: 30, price: '1000' });

    expect(prisma.plan.create.mock.calls[0][0].data.slug).toMatch(/^plan-[0-9a-f-]{36}$/);
  });

  it('keeps the existing slug when renaming a plan in Persian', async () => {
    const existing = { id: 1n, publicId: 'plan-1', slug: 'stable-slug' };
    const prisma = {
      plan: {
        findUnique: jest.fn().mockResolvedValue(existing),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...existing,
          description: null,
          type: 'TIME',
          trafficLimitGb: null,
          trafficLimitBytes: null,
          durationDays: 30,
          deviceLimit: 1,
          serverLimit: 1,
          price: 1000n,
          originalPrice: null,
          discountPercent: null,
          currency: 'IRT',
          priority: 0,
          isVisible: true,
          countries: [],
          isTrial: false,
          isRenewable: true,
          isTransferable: false,
          allowPause: false,
          status: 'ACTIVE',
          inboundPolicy: 'ALL_ACTIVE',
          panelId: null,
          ...data,
        })),
      },
    };
    const service = new PlansService(
      prisma as never,
      { del: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await service.update('plan-1', { name: 'نام جدید' });

    expect(prisma.plan.update.mock.calls[0][0].data.slug).toBe('stable-slug');
  });
});
