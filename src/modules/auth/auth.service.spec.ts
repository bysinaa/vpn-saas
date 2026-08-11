jest.mock('@/config', () => ({
  config: {
    telegram: { adminIds: [] },
    jwt: { refreshTtl: '7d' },
  },
}));
jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('@/common/redis/redis.service', () => ({ RedisService: class RedisService {} }));
jest.mock('@/common/audit/audit.service', () => ({ AuditService: class AuditService {} }));
jest.mock('./password.service', () => ({ PasswordService: class PasswordService {} }));
jest.mock('./jwt-token.service', () => ({ JwtTokenService: class JwtTokenService {} }));

import { AuthService } from './auth.service';

describe('AuthService Telegram referrals', () => {
  it('records a pending referral and credits both signup rewards from canonical settings', async () => {
    const createdUser = {
      id: 3n,
      publicId: 'user-3',
      role: 'USER',
      email: null,
      telegramId: '300',
    };
    const tx = {
      user: { create: jest.fn().mockResolvedValue(createdUser) },
      referralLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      wallet: {
        upsert: jest.fn(async ({ where }) => ({ id: where.userId, balance: 0n })),
        update: jest.fn(async ({ where, data }) => ({
          id: where.id,
          balance: data.balance.increment,
        })),
      },
      walletTransaction: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ id: 9n }),
      },
      systemSetting: {
        findMany: jest.fn().mockResolvedValue([
          { key: 'referral.enabled', value: 'true' },
          { key: 'referral.referrerReward', value: '50000' },
          { key: 'referral.referredReward', value: '25000' },
        ]),
      },
      withTransaction: jest.fn(async (callback) => callback(tx)),
      userSession: { create: jest.fn().mockResolvedValue({}) },
    };
    const tokens = {
      generatePair: jest.fn().mockResolvedValue({
        tokens: { accessToken: 'access', refreshToken: 'refresh' },
        refreshTokenRaw: 'refresh',
      }),
      hashRefreshToken: jest.fn().mockReturnValue('hash'),
    };
    const service = new AuthService(
      prisma as any,
      {} as any,
      { log: jest.fn() } as any,
      {} as any,
      tokens as any,
    );

    await service.mintForTelegramUser({ telegramId: '300', referralCode: 'invite-1' });

    expect(tx.referralLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        referrerId: 9n,
        referredId: 3n,
        status: 'PENDING',
        referrerReward: 50000n,
        referredReward: 25000n,
      }),
    });
    expect(tx.walletTransaction.create.mock.calls.map((call) => call[0].data.amount)).toEqual([
      50000n,
      25000n,
    ]);
  });
});
