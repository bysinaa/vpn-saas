import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/redis/redis.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import {
  PaginatedDto,
  PaginationParams,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import type { Language, UserStatus, UserRole } from '@prisma/client';

export interface UserDto {
  id: string;
  publicId: string;
  telegramId: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  language: Language;
  role: UserRole;
  status: UserStatus;
  referralCode: string;
  avatarUrl: string | null;
  isEmailVerified: boolean;
  createdAt: Date;
}

/**
 * UsersService - CRUD + profile management for users.
 * Admin operations (list, suspend, role changes) and self-service profile ops.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async findById(id: bigint): Promise<UserDto> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw BusinessException.notFound('User not found');
    return this.toDto(user);
  }

  async findByPublicId(publicId: string): Promise<UserDto> {
    const user = await this.prisma.user.findUnique({ where: { publicId } });
    if (!user || user.deletedAt) throw BusinessException.notFound('User not found');
    return this.toDto(user);
  }

  async findPaginated(query: Record<string, unknown>): Promise<PaginatedDto<UserDto>> {
    const params = parsePagination(query);
    const where = this.buildFilter(query);
    const [total, items] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        ...skipTake(params),
        orderBy: this.orderBy(params),
      }),
    ]);
    return { data: items.map(this.toDto), meta: buildMeta(total, params) };
  }

  async updateProfile(
    id: bigint,
    input: { username?: string; firstName?: string; lastName?: string; phone?: string; language?: Language; avatarUrl?: string },
  ): Promise<UserDto> {
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        username: input.username,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        language: input.language,
        avatarUrl: input.avatarUrl,
      },
    });
    await this.invalidateUserCache(id);
    return this.toDto(user);
  }

  async changeStatus(id: bigint, status: UserStatus): Promise<UserDto> {
    const user = await this.prisma.user.update({ where: { id }, data: { status } });
    await this.invalidateUserCache(id);
    // Revoke sessions on ban
    if (status === 'BANNED' || status === 'DELETED') {
      await this.prisma.userSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return this.toDto(user);
  }

  async changeRole(id: bigint, role: UserRole): Promise<UserDto> {
    if (role === 'SUPER_ADMIN') throw BusinessException.forbidden('Cannot assign SUPER_ADMIN via API');
    const user = await this.prisma.user.update({ where: { id }, data: { role } });
    await this.invalidateUserCache(id);
    return this.toDto(user);
  }

  async softDelete(id: bigint): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { status: 'DELETED', deletedAt: new Date() },
    });
    await this.invalidateUserCache(id);
  }

  async getStats(): Promise<{
    total: number;
    active: number;
    suspended: number;
    newToday: number;
  }> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [total, active, suspended, newToday] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { status: 'ACTIVE', deletedAt: null } }),
      this.prisma.user.count({ where: { status: 'SUSPENDED', deletedAt: null } }),
      this.prisma.user.count({ where: { createdAt: { gte: startOfDay }, deletedAt: null } }),
    ]);
    return { total, active, suspended, newToday };
  }

  // ---------- helpers ----------
  private buildFilter(query: Record<string, unknown>) {
    const where: Record<string, unknown> = { deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.role) where.role = query.role;
    if (query.language) where.language = query.language;
    if (typeof query.search === 'string' && query.search) {
      where.OR = [
        { email: { contains: query.search, mode: 'insensitive' } },
        { username: { contains: query.search, mode: 'insensitive' } },
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { telegramId: { contains: query.search } },
      ];
    }
    return where;
  }

  private orderBy(params: PaginationParams) {
    const allowed = ['createdAt', 'updatedAt', 'lastLoginAt', 'username', 'email'];
    const field = params.sortBy && allowed.includes(params.sortBy) ? params.sortBy : 'createdAt';
    return { [field]: params.sortOrder };
  }

  private async invalidateUserCache(id: bigint): Promise<void> {
    await this.redis.delByPattern(`auth:perms:${id}`);
  }

  private toDto = (u: any): UserDto => ({
    id: u.id.toString(),
    publicId: u.publicId,
    telegramId: u.telegramId ?? null,
    username: u.username ?? null,
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    email: u.email ?? null,
    phone: u.phone ?? null,
    language: u.language,
    role: u.role,
    status: u.status,
    referralCode: u.referralCode,
    avatarUrl: u.avatarUrl ?? null,
    isEmailVerified: u.isEmailVerified ?? false,
    createdAt: u.createdAt,
  });
}
