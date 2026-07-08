import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/redis/redis.service';
import { AuditService } from '@/common/audit/audit.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import type { CryptoCurrency } from '@prisma/client';

export interface CryptoWalletDto {
  id: string;
  publicId: string;
  currency: CryptoCurrency;
  label: string | null;
  address: string;
  network: string | null;
  instructions: string | null;
  qrCodeUrl: string | null;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CACHE_KEY = 'crypto-wallets:active';

/**
 * CryptoWalletsService (spec #4) — admin-managed cryptocurrency deposit
 * addresses (USDT TRC20, USDT ERC20, TON, BTC, ETH). Users always get the
 * latest configured wallet; nothing is hardcoded. Admins can add/edit/delete/
 * enable-disable wallets and set defaults. Every mutation is audit-logged.
 */
@Injectable()
export class CryptoWalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  /** Public: active wallets grouped for display to depositing users. */
  async listActive(): Promise<CryptoWalletDto[]> {
    const cached = await this.redis.getJson<CryptoWalletDto[]>(CACHE_KEY);
    if (cached) return cached;
    const wallets = await this.prisma.cryptoWallet.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    const dtos = wallets.map(this.toDto);
    await this.redis.setJson(CACHE_KEY, dtos, 300);
    return dtos;
  }

  /** The default wallet for a specific currency (what the bot shows first). */
  async getDefault(currency: CryptoCurrency): Promise<CryptoWalletDto | null> {
    const wallets = await this.listActive();
    const byCurrency = wallets.filter((w) => w.currency === currency);
    return byCurrency.find((w) => w.isDefault) ?? byCurrency[0] ?? null;
  }

  async listAll(query: Record<string, unknown>): Promise<PaginatedDto<CryptoWalletDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.currency) where.currency = query.currency;
    if (query.isActive !== undefined) where.isActive = query.isActive === 'true';
    if (typeof query.search === 'string' && query.search) {
      where.OR = [
        { address: { contains: query.search, mode: 'insensitive' } },
        { label: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [total, items] = await Promise.all([
      this.prisma.cryptoWallet.count({ where }),
      this.prisma.cryptoWallet.findMany({
        where,
        ...skipTake(params),
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return { data: items.map(this.toDto), meta: buildMeta(total, params) };
  }

  async create(
    input: {
      currency: CryptoCurrency;
      address: string;
      network?: string;
      label?: string;
      instructions?: string;
      qrCodeUrl?: string;
      isActive?: boolean;
      isDefault?: boolean;
      sortOrder?: number;
    },
    adminId?: bigint,
  ): Promise<CryptoWalletDto> {
    if (input.isDefault) await this.clearDefault(input.currency);
    const wallet = await this.prisma.cryptoWallet.create({
      data: {
        currency: input.currency,
        address: input.address.trim(),
        network: input.network ?? null,
        label: input.label ?? null,
        instructions: input.instructions ?? null,
        qrCodeUrl: input.qrCodeUrl ?? null,
        isActive: input.isActive ?? true,
        isDefault: input.isDefault ?? false,
        sortOrder: input.sortOrder ?? 0,
        createdById: adminId ?? null,
      },
    });
    await this.invalidate();
    await this.audit.log({
      userId: adminId,
      action: 'CREATE',
      resource: 'crypto_wallets',
      resourceId: wallet.publicId,
      after: this.toDto(wallet),
    });
    return this.toDto(wallet);
  }

  async update(
    publicId: string,
    input: Partial<{
      address: string;
      network: string | null;
      label: string | null;
      instructions: string | null;
      qrCodeUrl: string | null;
      isActive: boolean;
      isDefault: boolean;
      sortOrder: number;
    }>,
    adminId?: bigint,
  ): Promise<CryptoWalletDto> {
    const existing = await this.prisma.cryptoWallet.findUnique({ where: { publicId } });
    if (!existing) throw BusinessException.notFound('Crypto wallet not found');
    if (input.isDefault) await this.clearDefault(existing.currency);
    const data: Record<string, unknown> = {};
    if (input.address !== undefined) data.address = input.address.trim();
    if (input.network !== undefined) data.network = input.network;
    if (input.label !== undefined) data.label = input.label;
    if (input.instructions !== undefined) data.instructions = input.instructions;
    if (input.qrCodeUrl !== undefined) data.qrCodeUrl = input.qrCodeUrl;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.isDefault !== undefined) data.isDefault = input.isDefault;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    const wallet = await this.prisma.cryptoWallet.update({ where: { publicId }, data });
    await this.invalidate();
    await this.audit.log({
      userId: adminId,
      action: 'UPDATE',
      resource: 'crypto_wallets',
      resourceId: publicId,
      before: this.toDto(existing),
      after: this.toDto(wallet),
    });
    return this.toDto(wallet);
  }

  async remove(publicId: string, adminId?: bigint): Promise<void> {
    const existing = await this.prisma.cryptoWallet.findUnique({ where: { publicId } });
    if (!existing) throw BusinessException.notFound('Crypto wallet not found');
    await this.prisma.cryptoWallet.delete({ where: { publicId } });
    await this.invalidate();
    await this.audit.log({
      userId: adminId,
      action: 'DELETE',
      resource: 'crypto_wallets',
      resourceId: publicId,
      before: this.toDto(existing),
    });
  }

  private async clearDefault(currency: CryptoCurrency): Promise<void> {
    await this.prisma.cryptoWallet.updateMany({
      where: { currency, isDefault: true },
      data: { isDefault: false },
    });
  }

  private async invalidate(): Promise<void> {
    await this.redis.del(CACHE_KEY);
  }

  private toDto = (w: any): CryptoWalletDto => ({
    id: w.id.toString(),
    publicId: w.publicId,
    currency: w.currency,
    label: w.label ?? null,
    address: w.address,
    network: w.network ?? null,
    instructions: w.instructions ?? null,
    qrCodeUrl: w.qrCodeUrl ?? null,
    isActive: w.isActive,
    isDefault: w.isDefault,
    sortOrder: w.sortOrder,
    createdById: w.createdById?.toString() ?? null,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });
}
