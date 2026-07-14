import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/redis/redis.service';
import { AuditService } from '@/common/audit/audit.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { config } from '@/config';
import type { Prisma, UserRole, UserStatus } from '@prisma/client';
import { PasswordService } from './password.service';
import { JwtTokenService } from './jwt-token.service';
import { LoginInput, LoginResult } from './auth.types';
import { AuthSchemas } from './auth.schemas';

/**
 * AuthService - the heart of authentication. Handles registration, login,
 * refresh-token rotation, logout and permission resolution (RBAC).
 *
 * Refresh tokens are stored hashed in user_sessions and rotated on each use
 * (refresh-token reuse detection for security).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly tokens: JwtTokenService,
  ) {}

  // ---------- Registration (email/password) ----------
  async registerEmail(input: { email: string; password: string; username?: string }): Promise<LoginResult> {
    AuthSchemas.register.parse(input);

    const exists = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (exists) throw BusinessException.conflict('Email already registered');

    const passwordHash = await this.passwords.hash(input.password);
    const referralCode = await this.generateReferralCode();

    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        username: input.username,
        passwordHash,
        language: 'EN',
        role: 'USER',
        status: 'ACTIVE',
        isEmailVerified: false,
        referralCode,
        wallet: { create: {} },
      },
      include: { wallet: true },
    });

    await this.audit.log({
      action: 'CREATE',
      resource: 'users',
      // audit.log expects resourceId as string|number; convert bigint.
      resourceId: user.id.toString(),
      after: { email: user.email },
    });

    return this.issueSession(user.id, user.publicId, user.role, user.email, user.telegramId, {
      userAgent: '',
      ip: '',
    });
  }

  // ---------- Login ----------
  async login(input: LoginInput): Promise<LoginResult> {
    AuthSchemas.login.parse(input);

    // Brute force protection keyed on email or telegramId
    const bruteKey = `auth:brute:${input.email ?? input.telegramId ?? 'anon'}`;
    const attempts = await this.redis.incr(bruteKey, 900);
    if (attempts > 5) {
      throw BusinessException.forbidden('Too many failed attempts. Try again later.');
    }

    let user: Awaited<ReturnType<PrismaService['user']['findFirst']>> = null;
    if (input.email) {
      user = await this.prisma.user.findUnique({
        where: { email: input.email },
        include: { wallet: true },
      });
    } else if (input.telegramId) {
      user = await this.prisma.user.findUnique({
        where: { telegramId: input.telegramId },
        include: { wallet: true },
      });
    }

    if (!user || !user.passwordHash) {
      await this.delay();
      throw BusinessException.unauthorized('Invalid credentials');
    }

    const ok = await this.passwords.compare(input.password ?? '', user.passwordHash);
    if (!ok) {
      await this.delay();
      throw BusinessException.unauthorized('Invalid credentials');
    }

    if (user.status === 'BANNED' || user.status === 'DELETED') {
      throw BusinessException.forbidden('Account is not active');
    }

    // Successful login -> clear brute counter
    await this.redis.del(bruteKey);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastSeenAt: new Date() },
    });

    await this.audit.log({
      userId: user.id,
      action: 'LOGIN',
      resource: 'auth',
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return this.issueSession(user.id, user.publicId, user.role, user.email, user.telegramId, {
      userAgent: input.userAgent ?? '',
      ip: input.ip ?? '',
    });
  }

  // ---------- Refresh token rotation ----------
  async refresh(refreshToken: string, userAgent?: string, ip?: string): Promise<LoginResult> {
    let payload: Awaited<ReturnType<JwtTokenService['verifyRefresh']>>;
    try {
      payload = await this.tokens.verifyRefresh(refreshToken);
    } catch {
      throw BusinessException.unauthorized('Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') {
      throw BusinessException.unauthorized('Invalid token type');
    }

    // Find an active session matching this refresh token hash
    const session = await this.prisma.userSession.findFirst({
      where: { refreshTokenHash: refreshToken, revokedAt: null },
    });
    if (!session) {
      // Possible token reuse -> revoke all sessions for this user
      await this.prisma.userSession.updateMany({
        where: { userId: BigInt(payload.sub), revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw BusinessException.unauthorized('Session invalidated (token reuse detected)');
    }
    if (session.expiresAt < new Date()) {
      throw BusinessException.unauthorized('Session expired');
    }

    // Rotate: revoke old session
    await this.prisma.userSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    const user = await this.prisma.user.findUnique({ where: { id: BigInt(payload.sub) } });
    if (!user || user.status !== 'ACTIVE') {
      throw BusinessException.unauthorized('Account is not active');
    }

    return this.issueSession(user.id, user.publicId, user.role, user.email, user.telegramId, {
      userAgent: userAgent ?? '',
      ip: ip ?? '',
    });
  }

  // ---------- Logout ----------
  async logout(accessToken: string): Promise<void> {
    try {
      const payload = await this.tokens.verifyAccess(accessToken);
      // Revoke the user's sessions (could be refined to a single jti)
      await this.prisma.userSession.updateMany({
        where: { userId: BigInt(payload.sub), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      // Best-effort logout
    }
  }

  // ---------- Telegram auth (token minted by TelegramService after /start) ----------
  async mintForTelegramUser(input: {
    telegramId: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    languageCode?: string;
    referralCode?: string;
    deviceFingerprint?: string;
    ip?: string;
  }): Promise<LoginResult> {
    const language = this.normalizeLanguage(input.languageCode);
    // Operators listed in TELEGRAM_ADMIN_IDS are granted SUPER_ADMIN so they see
    // the admin menu (spec #10). Computed here so both the create and update
    // branches honor it — existing USERs in adminIds get promoted on next /start.
    const isAdmin = config.telegram.adminIds.includes(input.telegramId);

    // Find or create user
    let user = await this.prisma.user.findUnique({
      where: { telegramId: input.telegramId },
      include: { wallet: true },
    });

    if (!user) {
      const referralCode = input.referralCode?.trim().toUpperCase();
      const referrer =
        referralCode && referralCode.length
          ? await this.prisma.user.findFirst({
              where: {
                referralCode,
                status: 'ACTIVE',
                telegramId: { not: input.telegramId },
              },
            })
          : null;
      const newReferralCode = await this.generateReferralCode();
      const referralReward = BigInt(
        (await this.prisma.systemSetting.findUnique({
          where: { key: 'referral.signup_bonus_minor' },
          select: { value: true },
        }))?.value ?? '0',
      );

      user = await this.prisma.withTransaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            telegramId: input.telegramId,
            username: input.username,
            firstName: input.firstName,
            lastName: input.lastName,
            language,
            role: isAdmin ? 'SUPER_ADMIN' : 'USER',
            status: 'ACTIVE',
            referralCode: newReferralCode,
            referredById: referrer?.id,
            deviceFingerprint: input.deviceFingerprint,
            wallet: { create: {} },
          },
          include: { wallet: true },
        });

        if (referrer) {
          const existingReferral = await tx.referralLog.findFirst({
            where: {
              OR: [
                { referredId: createdUser.id },
                { referred: { telegramId: input.telegramId } },
              ],
            },
            select: { id: true },
          });

          if (!existingReferral) {
            await tx.referralLog.create({
              data: {
                referrerId: referrer.id,
                referredId: createdUser.id,
                status: referralReward > 0n ? 'COMPLETED' : 'PENDING',
                referrerReward: referralReward,
                metadata: {
                  source: 'telegram_start',
                  telegramId: input.telegramId,
                  rewardedAt: referralReward > 0n ? new Date().toISOString() : null,
                } as Prisma.InputJsonValue,
              },
            });

            if (referralReward > 0n) {
              const referrerWallet = await tx.wallet.upsert({
                where: { userId: referrer.id },
                update: {},
                create: { userId: referrer.id },
              });

              await tx.walletTransaction.create({
                data: {
                  publicId: randomUUID(),
                  walletId: referrerWallet.id,
                  type: 'REFERRAL_REWARD',
                  status: 'CONFIRMED',
                  amount: referralReward,
                  fee: 0n,
                  balanceBefore: referrerWallet.balance,
                  balanceAfter: referrerWallet.balance + referralReward,
                  description: `Referral reward for ${input.telegramId}`,
                  reference: referralCode,
                  metadata: {
                    referredTelegramId: input.telegramId,
                    referredUserId: createdUser.id.toString(),
                  } as Prisma.InputJsonValue,
                },
              });

              await tx.wallet.update({
                where: { userId: referrer.id },
                data: { balance: { increment: referralReward } },
              });
            }
          }
        }

        return createdUser;
      });
    } else {
      // Update profile fields on each start; promote to SUPER_ADMIN if this
      // telegramId is now in adminIds but was previously a plain USER. Never
      // demote an existing admin (e.g. a manually-set ADMIN/OPERATOR).
      const shouldPromote = isAdmin && user.role === 'USER';
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          username: input.username ?? user.username,
          firstName: input.firstName ?? user.firstName,
          lastName: input.lastName ?? user.lastName,
          language,
          lastSeenAt: new Date(),
          ...(shouldPromote ? { role: 'SUPER_ADMIN' as UserRole } : {}),
        },
        include: { wallet: true },
      });
      if (shouldPromote) {
        await this.audit.log({
          action: 'UPDATE',
          resource: 'users',
          resourceId: user.publicId,
          before: { role: 'USER' },
          after: { role: 'SUPER_ADMIN' },
          metadata: { reason: 'Auto-promoted via TELEGRAM_ADMIN_IDS on /start' },
        });
      }
    }

    return this.issueSession(user.id, user.publicId, user.role, user.email, user.telegramId, {
      userAgent: 'telegram-bot',
      ip: input.ip ?? '',
    });
  }

  // ---------- RBAC permission resolution ----------
  async getPermissions(userId: bigint): Promise<string[]> {
    const cacheKey = `auth:perms:${userId}`;
    return this.redis.cached(cacheKey, 300, async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (!user) return [];
      if (user.role === 'SUPER_ADMIN') {
        const all = await this.prisma.permission.findMany({ select: { name: true } });
        return all.map((p) => p.name);
      }
      const role = await this.prisma.role.findUnique({
        where: { name: user.role },
        include: { permissions: { include: { permission: true } } },
      });
      if (!role) return [];
      return role.permissions.map((rp) => rp.permission.name);
    });
  }

  hasPermission(perms: string[], required: string): boolean {
    if (perms.includes(required) || perms.some((p) => p.endsWith(`:${required.split(':')[1]}`) && p.startsWith('*'))) {
      return true;
    }
    // Wildcard all
    return perms.includes('*');
  }

  // ---------- Helpers ----------
  private async issueSession(
    id: bigint,
    publicId: string,
    role: UserRole,
    email: string | null,
    telegramId: string | null,
    ctx: { userAgent: string; ip: string },
  ): Promise<LoginResult> {
    const { tokens, refreshTokenRaw } = await this.tokens.generatePair({
      id,
      publicId,
      role,
      email,
      telegramId,
    });

    const expiresAt = new Date(Date.now() + this.ttlToMs(config.jwt.refreshTtl));
    await this.prisma.userSession.create({
      data: {
        userId: id,
        refreshTokenHash: refreshTokenRaw,
        deviceInfo: ctx.userAgent,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        expiresAt,
      },
    });

    return {
      user: {
        id: id.toString(),
        publicId,
        username: undefined,
        email,
        role,
        language: 'EN',
      },
      tokens,
    };
  }

  private async generateReferralCode(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = randomUUID().slice(0, 8).toUpperCase();
      const exists = await this.prisma.user.findUnique({ where: { referralCode: code } });
      if (!exists) return code;
    }
    return randomUUID().toUpperCase();
  }

  private normalizeLanguage(code?: string): 'EN' | 'FA' | 'RU' | 'AR' | 'TR' {
    const map: Record<string, 'EN' | 'FA' | 'RU' | 'AR' | 'TR'> = {
      en: 'EN',
      fa: 'FA',
      ru: 'RU',
      ar: 'AR',
      tr: 'TR',
    };
    return map[(code ?? 'en').toLowerCase()] ?? 'EN';
  }

  private ttlToMs(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl.trim());
    if (!match) return 7 * 24 * 3600 * 1000;
    const val = Number(match[1]);
    const unit = match[2];
    const mult = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
    return val * mult;
  }

  private async delay(ms = 400): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // expose for guards
  getUserById(id: bigint) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async getStatus(userId: bigint): Promise<UserStatus | null> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    return u?.status ?? null;
  }
}
