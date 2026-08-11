import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/auth.types';

export interface ApiKeyDto {
  id: string;
  publicId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  isActive: boolean;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface CreatedApiKeyDto extends ApiKeyDto {
  /** The full plaintext key. Only returned once at creation time. */
  plainKey: string;
}

/**
 * ApiKeyService - manages API keys for programmatic/external clients.
 *
 * Keys are stored as SHA-256 hashes (never plaintext). The full key is
 * returned ONLY at creation time. Keys follow the format:
 *   vpn_live_<32-char-hex>
 *
 * Authentication via API key is handled by a dedicated guard that looks up
 * the key hash and validates scopes.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);
  private static readonly PREFIX = 'vpn_live_';

  constructor(private readonly prisma: PrismaService) {}

  async create(
    user: AuthenticatedUser,
    input: { name: string; scopes: string[]; expiresAt?: Date },
  ): Promise<CreatedApiKeyDto> {
    const rawKey = this.generateKey();
    const keyHash = this.hashKey(rawKey);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        name: input.name,
        keyHash,
        keyPrefix: rawKey.slice(0, 12),
        userId: user.id,
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
        isActive: true,
      },
    });

    this.logger.log(`API key created: '${input.name}' for user ${user.id}`);
    return { ...this.toDto(apiKey), plainKey: rawKey };
  }

  async listMine(userId: bigint): Promise<ApiKeyDto[]> {
    const keys = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map((k) => this.toDto(k));
  }

  async listAll(): Promise<ApiKeyDto[]> {
    const keys = await this.prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return keys.map((k) => this.toDto(k));
  }

  async update(
    publicId: string,
    input: {
      name?: string;
      scopes?: string[];
      isActive?: boolean;
      expiresAt?: Date | null;
    },
  ): Promise<ApiKeyDto> {
    const existing = await this.prisma.apiKey.findUnique({
      where: { publicId },
    });
    if (!existing) throw BusinessException.notFound('API key not found');

    const updated = await this.prisma.apiKey.update({
      where: { publicId },
      data: {
        name: input.name,
        scopes: input.scopes,
        isActive: input.isActive,
        expiresAt: input.expiresAt,
      },
    });
    return this.toDto(updated);
  }

  async revoke(publicId: string): Promise<void> {
    const existing = await this.prisma.apiKey.findUnique({
      where: { publicId },
    });
    if (!existing) throw BusinessException.notFound('API key not found');
    await this.prisma.apiKey.update({
      where: { publicId },
      data: { isActive: false },
    });
    this.logger.log(`API key revoked: ${existing.name}`);
  }

  async delete(publicId: string): Promise<void> {
    await this.prisma.apiKey.deleteMany({ where: { publicId } });
  }

  /**
   * Validate an API key by its plaintext value and return the associated
   * user ID + scopes. Used by the ApiKeyGuard.
   */
  async validate(rawKey: string): Promise<{
    userId: bigint;
    scopes: string[];
  } | null> {
    if (!rawKey.startsWith(ApiKeyService.PREFIX)) return null;
    const keyHash = this.hashKey(rawKey);
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
    });
    if (!apiKey || !apiKey.isActive) return null;
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;

    // Update lastUsedAt (fire-and-forget, non-blocking)
    this.prisma.apiKey
      .update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err) => this.logger.error(`Failed to update lastUsedAt: ${err.message}`));

    return {
      userId: apiKey.userId ?? 0n,
      scopes: apiKey.scopes,
    };
  }

  // ---- Helpers ----

  private generateKey(): string {
    return `${ApiKeyService.PREFIX}${randomBytes(16).toString('hex')}`;
  }

  private hashKey(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  private toDto(k: any): ApiKeyDto {
    return {
      id: k.id.toString(),
      publicId: k.publicId,
      name: k.name,
      keyPrefix: k.keyPrefix,
      scopes: k.scopes ?? [],
      isActive: k.isActive,
      lastUsedAt: k.lastUsedAt ?? null,
      expiresAt: k.expiresAt ?? null,
      createdAt: k.createdAt,
    };
  }
}
