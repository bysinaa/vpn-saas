import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { config } from '@/config';
import { hashToken } from '@/common/utils/crypto.util';
import { JwtPayload, TokenPair } from './auth.types';
import type { UserRole } from '@prisma/client';

/**
 * JwtTokenService - issues access/refresh token pairs and rotates refresh
 * tokens (stored hashed in user_sessions for revocation support).
 */
@Injectable()
export class JwtTokenService {
  constructor(private readonly jwt: JwtService) {}

  async generatePair(input: {
    id: bigint;
    publicId: string;
    role: UserRole;
    email?: string | null;
    telegramId?: string | null;
  }): Promise<{ tokens: TokenPair; refreshTokenRaw: string }> {
    const base: Omit<JwtPayload, 'type'> = {
      sub: input.id.toString(),
      publicId: input.publicId,
      role: input.role,
      email: input.email ?? null,
      telegramId: input.telegramId ?? null,
    };

    const accessToken = await this.jwt.signAsync(
      { ...base, type: 'access' },
      {
        secret: config.jwt.accessSecret,
        expiresIn: config.jwt.accessTtl,
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
      },
    );

    const refreshTokenRaw = randomBytes(48).toString('base64url');
    const accessPayload = await this.jwt.verifyAsync<JwtPayload>(accessToken, {
      secret: config.jwt.accessSecret,
    });

    const refreshToken = await this.jwt.signAsync(
      {
        ...base,
        type: 'refresh',
        jti: hashToken(refreshTokenRaw),
      },
      {
        secret: config.jwt.refreshSecret,
        expiresIn: config.jwt.refreshTtl,
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
      },
    );

    const expiresIn = this.ttlToSeconds(config.jwt.accessTtl);
    return {
      tokens: { accessToken, refreshToken, expiresIn },
      refreshTokenRaw: refreshTokenRaw,
      // accessPayload unused here but kept for potential immediate expiry calc
      ...(accessPayload ? {} : {}),
    };
  }

  async verifyAccess(token: string): Promise<JwtPayload> {
    return this.jwt.verifyAsync<JwtPayload>(token, {
      secret: config.jwt.accessSecret,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  }

  async verifyRefresh(token: string): Promise<JwtPayload> {
    return this.jwt.verifyAsync<JwtPayload>(token, {
      secret: config.jwt.refreshSecret,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  }

  hashRefreshToken(raw: string): string {
    return hashToken(raw);
  }

  private ttlToSeconds(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl.trim());
    if (!match) return 900;
    const val = Number(match[1]);
    const unit = match[2];
    const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
    return val * mult;
  }
}
