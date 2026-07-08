import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/redis/redis.service';
import { BusinessException } from '@/common/exceptions/business.exception';

export interface SettingDto {
  id: string;
  key: string;
  value: string;
  category: string;
  type: string;
  isPublic: boolean;
  editable: boolean;
  description: string | null;
  updatedAt: Date;
}

export interface FeatureFlagDto {
  id: string;
  key: string;
  enabled: boolean;
  rolloutPercent: number;
  description: string | null;
  updatedAt: Date;
}

const CACHE_PREFIX = 'settings:';
const CACHE_TTL = 300; // 5 minutes
const FLAGS_CACHE_PREFIX = 'flags:';

/**
 * SettingsService - manages system-wide configuration (SystemSetting)
 * and feature flags (FeatureFlag). Both are cached in Redis for fast reads.
 *
 * Public settings are exposed to clients without auth; private settings
 * require admin permissions.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ---- System Settings ----

  async listPublic(): Promise<SettingDto[]> {
    const cached = await this.redis.getJson<SettingDto[]>(`${CACHE_PREFIX}public`);
    if (cached) return cached;
    const settings = await this.prisma.systemSetting.findMany({
      where: { isPublic: true },
      orderBy: { key: 'asc' },
    });
    const dtos = settings.map((s) => this.toSettingDto(s));
    await this.redis.setJson(`${CACHE_PREFIX}public`, dtos, CACHE_TTL);
    return dtos;
  }

  async listAll(category?: string): Promise<SettingDto[]> {
    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    const settings = await this.prisma.systemSetting.findMany({
      where,
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });
    return settings.map((s) => this.toSettingDto(s));
  }

  async get(key: string): Promise<SettingDto> {
    const cached = await this.redis.getJson<SettingDto>(`${CACHE_PREFIX}key:${key}`);
    if (cached) return cached;
    const setting = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (!setting) throw BusinessException.notFound(`Setting not found: ${key}`);
    const dto = this.toSettingDto(setting);
    await this.redis.setJson(`${CACHE_PREFIX}key:${key}`, dto, CACHE_TTL);
    return dto;
  }

  /** Get a raw setting value as a typed primitive (useful internally). */
  async getValue<T = string>(key: string, fallback?: T): Promise<T> {
    try {
      const setting = await this.get(key);
      return this.coerceValue(setting.value, setting.type) as T;
    } catch {
      if (fallback !== undefined) return fallback;
      throw BusinessException.notFound(`Setting not found: ${key}`);
    }
  }

  async upsert(input: {
    key: string;
    value: string;
    category?: string;
    type?: string;
    isPublic?: boolean;
    editable?: boolean;
    description?: string;
  }): Promise<SettingDto> {
    const existing = await this.prisma.systemSetting.findUnique({
      where: { key: input.key },
    });
    if (existing && !existing.editable) {
      throw BusinessException.conflict(`Setting '${input.key}' is not editable`);
    }
    const setting = await this.prisma.systemSetting.upsert({
      where: { key: input.key },
      update: {
        value: input.value,
        category: input.category,
        type: input.type,
        isPublic: input.isPublic,
        editable: input.editable,
        description: input.description,
      },
      create: {
        key: input.key,
        value: input.value,
        category: input.category ?? 'GENERAL',
        type: input.type ?? 'STRING',
        isPublic: input.isPublic ?? false,
        editable: input.editable ?? true,
        description: input.description,
      },
    });
    await this.invalidateSettingCache(input.key);
    return this.toSettingDto(setting);
  }

  async remove(key: string): Promise<void> {
    const existing = await this.prisma.systemSetting.findUnique({
      where: { key },
    });
    if (!existing) return;
    if (!existing.editable) {
      throw BusinessException.conflict(`Setting '${key}' is not editable`);
    }
    await this.prisma.systemSetting.delete({ where: { key } });
    await this.invalidateSettingCache(key);
  }

  // ---- Feature Flags ----

  async listFlags(): Promise<FeatureFlagDto[]> {
    const cached = await this.redis.getJson<FeatureFlagDto[]>(`${FLAGS_CACHE_PREFIX}all`);
    if (cached) return cached;
    const flags = await this.prisma.featureFlag.findMany({
      orderBy: { key: 'asc' },
    });
    const dtos = flags.map((f) => this.toFlagDto(f));
    await this.redis.setJson(`${FLAGS_CACHE_PREFIX}all`, dtos, CACHE_TTL);
    return dtos;
  }

  /**
   * Check if a feature flag is enabled for a given user identifier.
   * Uses rollout percentage for gradual rollouts.
   */
  async isFlagEnabled(key: string, userId?: string): Promise<boolean> {
    const cached = await this.redis.getJson<FeatureFlagDto>(`${FLAGS_CACHE_PREFIX}key:${key}`);
    const flag =
      cached ??
      (await this.prisma.featureFlag.findUnique({ where: { key } }));
    if (!cached && flag) {
      await this.redis.setJson(`${FLAGS_CACHE_PREFIX}key:${key}`, this.toFlagDto(flag), CACHE_TTL);
    }
    if (!flag) return false;
    if (!flag.enabled) return false;
    if (flag.rolloutPercent >= 100) return true;
    if (flag.rolloutPercent <= 0) return false;
    if (!userId) return false;
    // Deterministic hash-based rollout so a given user always sees the same result
    const hash = this.hashString(userId + key);
    return hash % 100 < flag.rolloutPercent;
  }

  async upsertFlag(
    key: string,
    input: { enabled?: boolean; rolloutPercent?: number; description?: string },
  ): Promise<FeatureFlagDto> {
    const flag = await this.prisma.featureFlag.upsert({
      where: { key },
      update: {
        enabled: input.enabled,
        rolloutPercent: input.rolloutPercent,
        description: input.description,
      },
      create: {
        key,
        enabled: input.enabled ?? false,
        rolloutPercent: input.rolloutPercent ?? 0,
        description: input.description,
      },
    });
    await this.invalidateFlagCache(key);
    return this.toFlagDto(flag);
  }

  async removeFlag(key: string): Promise<void> {
    await this.prisma.featureFlag.delete({ where: { key } }).catch(() => undefined);
    await this.invalidateFlagCache(key);
  }

  // ---- Cache helpers ----

  private async invalidateSettingCache(key: string): Promise<void> {
    await Promise.all([
      this.redis.del(`${CACHE_PREFIX}key:${key}`),
      this.redis.del(`${CACHE_PREFIX}public`),
    ]);
  }

  private async invalidateFlagCache(key: string): Promise<void> {
    await Promise.all([
      this.redis.del(`${FLAGS_CACHE_PREFIX}key:${key}`),
      this.redis.del(`${FLAGS_CACHE_PREFIX}all`),
    ]);
  }

  // ---- DTOs and helpers ----

  private toSettingDto(s: any): SettingDto {
    return {
      id: s.id.toString(),
      key: s.key,
      value: s.value,
      category: s.category,
      type: s.type,
      isPublic: s.isPublic,
      editable: s.editable,
      description: s.description ?? null,
      updatedAt: s.updatedAt,
    };
  }

  private toFlagDto(f: any): FeatureFlagDto {
    return {
      id: f.id.toString(),
      key: f.key,
      enabled: f.enabled,
      rolloutPercent: f.rolloutPercent,
      description: f.description ?? null,
      updatedAt: f.updatedAt,
    };
  }

  private coerceValue(value: string, type: string): unknown {
    switch (type) {
      case 'NUMBER':
        return Number(value);
      case 'BOOLEAN':
        return value === 'true' || value === '1';
      case 'JSON':
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      default:
        return value;
    }
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}
