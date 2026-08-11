jest.mock('@/config', () => ({
  config: { app: { url: 'https://app.test' }, payments: { online: { callbackUrl: '' } } },
}));
jest.mock('../wallet/wallet.service', () => ({ WalletService: class {} }));
jest.mock('../orders/orders.service', () => ({ OrdersService: class {} }));
jest.mock('../vpn/vpn.service', () => ({ VpnService: class {} }));
jest.mock('@/common/audit/audit.service', () => ({ AuditService: class {} }));
jest.mock('../notifications/notifications.service', () => ({ NotificationsService: class {} }));

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PaymentsService } from './payments.service';

const databaseUrl = process.env.PAYMENTS_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('PaymentsService PostgreSQL UUID order lock', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
  let userId: bigint;
  let planId: bigint;
  let orderPublicId: string;

  beforeAll(async () => {
    await prisma.$connect();
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { referralCode: `uuid-lock-${suffix}`, status: 'ACTIVE' },
    });
    userId = user.id;
    const plan = await prisma.plan.create({
      data: {
        name: 'UUID lock regression',
        slug: `uuid-lock-${suffix}`,
        type: 'TRAFFIC',
        price: 1n,
      },
    });
    planId = plan.id;
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        planId: plan.id,
        unitPrice: 1n,
        totalAmount: 1n,
        currency: 'IRT',
      },
    });
    orderPublicId = order.publicId;
  });

  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } });
    if (planId) await prisma.plan.delete({ where: { id: planId } });
    await prisma.$disconnect();
  });

  it('locks the real UUID column and continues the canonical wallet transaction', async () => {
    const payment: any = {
      id: 1n,
      publicId: randomUUID(),
      orderId: null,
      userId,
      method: 'WALLET',
      status: 'PENDING',
      amount: 1n,
      currency: 'IRT',
      order: { publicId: orderPublicId },
    };
    const paymentDelegate = {
      create: jest.fn(async ({ data }: any) => Object.assign(payment, data)),
      findUniqueOrThrow: jest.fn(async () => payment),
      updateMany: jest.fn(async ({ data }: any) => {
        Object.assign(payment, data);
        return { count: 1 };
      }),
    };
    const orders = {
      completeOrderInTransaction: jest.fn(async () => ({
        order: { publicId: orderPublicId, status: 'COMPLETED' },
        subscription: null,
        provisioningRequired: false,
      })),
    };
    const wallet = { mutateBalanceInTransaction: jest.fn().mockResolvedValue({ id: 1n }) };
    const service = new PaymentsService(
      {
        withTransaction: (callback: any) =>
          prisma.$transaction((tx) =>
            callback({
              $queryRaw: tx.$queryRaw.bind(tx),
              order: tx.order,
              payment: paymentDelegate,
            }),
          ),
      } as any,
      wallet as any,
      orders as any,
      { createVpnUserForSubscription: jest.fn() } as any,
      { log: jest.fn() } as any,
      { send: jest.fn() } as any,
      new Map() as any,
      { getValue: jest.fn() } as any,
      { getDepositCard: jest.fn() } as any,
      { getDefault: jest.fn() } as any,
    );

    await expect(service.payOrderWithWallet(orderPublicId, userId)).resolves.toMatchObject({
      order: { publicId: orderPublicId },
    });
    expect(wallet.mutateBalanceInTransaction).toHaveBeenCalledTimes(1);
    expect(orders.completeOrderInTransaction).toHaveBeenCalledTimes(1);
  });
});
