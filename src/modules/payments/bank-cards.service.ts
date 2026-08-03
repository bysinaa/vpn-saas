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

export interface BankCardDto {
  id: string;
  publicId: string;
  cardNumber: string;
  cardHolder: string;
  bankName: string;
  shebaNumber: string | null;
  label: string | null;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeCardNumber(value: string): string {
  return value.replace(/[\s-]/g, '');
}

export function isValidCardNumber(value: string): boolean {
  const card = normalizeCardNumber(value);
  if (!/^\d{16}$/.test(card) || /^0+$/.test(card)) return false;
  let sum = 0;
  for (let i = 0; i < card.length; i += 1) {
    let digit = Number(card[card.length - 1 - i]);
    if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function maskCardNumber(value: string): string {
  const card = normalizeCardNumber(value);
  return card.length <= 4 ? '••••' : `${'•'.repeat(Math.max(0, card.length - 4))}${card.slice(-4)}`;
}

const CACHE_KEY = 'bank-cards:active';

/**
 * BankCardsService (spec #3) — single source of truth for card-to-card
 * deposit cards. The bot never hardcodes card numbers; it always reads the
 * active rows from this service (which caches them in Redis).
 *
 * Admins can add / edit / delete / enable-disable cards, set a default and
 * reorder them. Every mutation is audit-logged.
 */
@Injectable()
export class BankCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  /** Public: the card(s) shown to users depositing via card-to-card. */
  async listActive(): Promise<BankCardDto[]> {
    const cached = await this.redis.getJson<BankCardDto[]>(CACHE_KEY);
    if (cached) return cached;
    const cards = await this.prisma.bankCard.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const dtos = cards.map(this.toDto);
    await this.redis.setJson(CACHE_KEY, dtos, 300);
    return dtos;
  }

  /** The single default/primary card a user should transfer to. */
  async getDepositCard(): Promise<BankCardDto | null> {
    const cards = await this.listActive();
    return cards[0] ?? null;
  }

  async findOne(publicId: string): Promise<BankCardDto> {
    const c = await this.prisma.bankCard.findUnique({ where: { publicId } });
    if (!c) throw BusinessException.notFound('Bank card not found');
    return this.toDto(c);
  }

  async listAll(query: Record<string, unknown>): Promise<PaginatedDto<BankCardDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.isActive !== undefined) where.isActive = query.isActive === 'true';
    if (typeof query.search === 'string' && query.search) {
      where.OR = [
        { cardHolder: { contains: query.search, mode: 'insensitive' } },
        { bankName: { contains: query.search, mode: 'insensitive' } },
        { cardNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [total, items] = await Promise.all([
      this.prisma.bankCard.count({ where }),
      this.prisma.bankCard.findMany({
        where,
        ...skipTake(params),
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return { data: items.map(this.toDto), meta: buildMeta(total, params) };
  }

  async create(
    input: {
      cardNumber: string;
      cardHolder: string;
      bankName: string;
      shebaNumber?: string;
      label?: string;
      isActive?: boolean;
      isDefault?: boolean;
      sortOrder?: number;
    },
    adminId?: bigint,
  ): Promise<BankCardDto> {
    // Only one card may be the default at a time.
    if (input.isDefault) await this.clearDefault();
    const card = await this.prisma.bankCard.create({
      data: {
        cardNumber: this.checkedCardNumber(input.cardNumber),
        cardHolder: input.cardHolder,
        bankName: input.bankName,
        shebaNumber: input.shebaNumber ?? null,
        label: input.label ?? null,
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
      resource: 'bank_cards',
      resourceId: card.publicId,
      after: this.toDto(card),
    });
    return this.toDto(card);
  }

  async update(
    publicId: string,
    input: Partial<{
      cardNumber: string;
      cardHolder: string;
      bankName: string;
      shebaNumber: string | null;
      label: string | null;
      isActive: boolean;
      isDefault: boolean;
      sortOrder: number;
    }>,
    adminId?: bigint,
  ): Promise<BankCardDto> {
    const existing = await this.prisma.bankCard.findUnique({ where: { publicId } });
    if (!existing) throw BusinessException.notFound('Bank card not found');
    if (input.isDefault) await this.clearDefault();
    const data: Record<string, unknown> = {};
    if (input.cardNumber !== undefined) data.cardNumber = this.checkedCardNumber(input.cardNumber);
    if (input.cardHolder !== undefined) data.cardHolder = input.cardHolder;
    if (input.bankName !== undefined) data.bankName = input.bankName;
    if (input.shebaNumber !== undefined) data.shebaNumber = input.shebaNumber;
    if (input.label !== undefined) data.label = input.label;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.isDefault !== undefined) data.isDefault = input.isDefault;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    const card = await this.prisma.bankCard.update({ where: { publicId }, data });
    await this.invalidate();
    await this.audit.log({
      userId: adminId,
      action: 'UPDATE',
      resource: 'bank_cards',
      resourceId: publicId,
      before: this.toDto(existing),
      after: this.toDto(card),
    });
    return this.toDto(card);
  }

  async remove(publicId: string, adminId?: bigint): Promise<void> {
    const existing = await this.prisma.bankCard.findUnique({ where: { publicId } });
    if (!existing) throw BusinessException.notFound('Bank card not found');
    // Preserve payment history: card removal is a soft disable.
    await this.prisma.bankCard.update({ where: { publicId }, data: { isActive: false, isDefault: false } });
    await this.invalidate();
    await this.audit.log({
      userId: adminId,
      action: 'UPDATE',
      resource: 'bank_cards',
      resourceId: publicId,
      before: this.toDto(existing),
    });
  }

  async setActive(publicId: string, isActive: boolean, adminId?: bigint): Promise<BankCardDto> {
    return this.update(publicId, { isActive, ...(isActive ? {} : { isDefault: false }) }, adminId);
  }

  async setDefault(publicId: string, adminId?: bigint): Promise<BankCardDto> {
    const card = await this.prisma.bankCard.findUnique({ where: { publicId } });
    if (!card) throw BusinessException.notFound('Bank card not found');
    if (!card.isActive) throw BusinessException.conflict('Only an active card can be default');
    await this.clearDefault();
    return this.update(publicId, { isDefault: true }, adminId);
  }

  private checkedCardNumber(value: string): string {
    const card = normalizeCardNumber(value);
    if (!isValidCardNumber(card)) throw new BusinessException('VALIDATION_ERROR', 'Invalid card number');
    return card;
  }

  private async clearDefault(): Promise<void> {
    await this.prisma.bankCard.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });
  }

  private async invalidate(): Promise<void> {
    await this.redis.del(CACHE_KEY);
  }

  private toDto = (c: any): BankCardDto => ({
    id: c.id.toString(),
    publicId: c.publicId,
    cardNumber: c.cardNumber,
    cardHolder: c.cardHolder,
    bankName: c.bankName,
    shebaNumber: c.shebaNumber ?? null,
    label: c.label ?? null,
    isActive: c.isActive,
    isDefault: c.isDefault,
    sortOrder: c.sortOrder,
    createdById: c.createdById?.toString() ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });
}
