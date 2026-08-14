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
  it('records one traffic referral for a new Telegram user and delegates fulfillment', async () => {
    const createdUser = {
      id: 3n,
      publicId: 'user-3',
      role: 'USER',
      email: null,
      telegramId: '300',
      referredById: 9n,
    };
    const tx = {
      user: { create: jest.fn().mockResolvedValue(createdUser) },
      referralLog: {
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
          { key: 'referral.rewardTrafficGb', value: '1' },
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
    const affiliate = { fulfillTelegramSignupReferral: jest.fn().mockResolvedValue(null) };
    const service = new AuthService(
      prisma as any,
      {} as any,
      { log: jest.fn() } as any,
      {} as any,
      tokens as any,
      affiliate as any,
    );

    await service.mintForTelegramUser({ telegramId: '300', referralCode: 'invite-1' });

    expect(tx.referralLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        referrerId: 9n,
        referredId: 3n,
        status: 'PENDING',
        rewardType: 'TRAFFIC',
        referrerReward: 1073741824n,
        referredReward: 1073741824n,
      }),
    });
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(affiliate.fulfillTelegramSignupReferral).toHaveBeenCalledWith(3n);
  });

  it('ignores referral links for a Telegram account that already exists', async () => {
    const existingUser = {
      id: 3n,
      publicId: 'user-3',
      role: 'USER',
      email: null,
      telegramId: '300',
      username: null,
      firstName: null,
      lastName: null,
      language: 'FA',
      referredById: null,
      wallet: {},
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(existingUser),
        update: jest.fn().mockResolvedValue(existingUser),
      },
      systemSetting: { findMany: jest.fn() },
      userSession: { create: jest.fn().mockResolvedValue({}) },
    };
    const tokens = {
      generatePair: jest.fn().mockResolvedValue({
        tokens: { accessToken: 'access', refreshToken: 'refresh' },
        refreshTokenRaw: 'refresh',
      }),
      hashRefreshToken: jest.fn().mockReturnValue('hash'),
    };
    const affiliate = { fulfillTelegramSignupReferral: jest.fn() };
    const service = new AuthService(
      prisma as any,
      {} as any,
      { log: jest.fn() } as any,
      {} as any,
      tokens as any,
      affiliate as any,
    );

    await service.mintForTelegramUser({ telegramId: '300', referralCode: 'ANOTHER-CODE' });

    expect(prisma.systemSetting.findMany).not.toHaveBeenCalled();
    expect(affiliate.fulfillTelegramSignupReferral).not.toHaveBeenCalled();
  });
});
