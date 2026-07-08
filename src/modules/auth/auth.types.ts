import type { UserRole } from '@prisma/client';

export interface JwtPayload {
  sub: string; // user id (string)
  publicId: string;
  role: UserRole;
  email?: string | null;
  telegramId?: string | null;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

export interface AuthenticatedUser {
  id: bigint;
  publicId: string;
  role: UserRole;
  email?: string | null;
  telegramId?: string | null;
  permissions?: string[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
}

export interface LoginInput {
  email?: string;
  telegramId?: string;
  password?: string;
  userAgent?: string;
  ip?: string;
}

export interface LoginResult {
  user: {
    id: string;
    publicId: string;
    username?: string | null;
    email?: string | null;
    role: UserRole;
    language: string;
  };
  tokens: TokenPair;
}
