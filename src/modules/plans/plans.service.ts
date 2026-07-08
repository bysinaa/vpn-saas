import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/redis/redis.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { fromMinor, toMinor, type MinorUnits } from '@/common/utils/money.util';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import type { PlanType } from '@prisma/client';

export interface PlanDto {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  description: string | null;
  type: PlanType;
  trafficLimitGb: string | null;
  durationDays: number | null;
  deviceLimit: number;
  serverLimit: number;
  price: string;
  originalPrice: string | null;
  discountPercent: string | null;
  currency: string;
  priority: number;
  isVisible: boolean;
  countries: string[];
  isTrial: boolean;
  isRenewable: boolean;
  isTransferable: boolean;
  allowPause: boolean;
  status: string;
}

export interface PlanCategoryDto {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
  status: string;
}

const CACHE_KEY_PLANS = 'plans:visible';

/**
 * PlansService - fully admin-configurable pricing management.
 * No plans are hardcoded; everything is created/edited via API.
 * Public plan list is cached for performance.
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ---------- Categories ----------
  async listCategories(): Promise<PlanCategoryDto[]> {
    const cats = await this.prisma.planCategory.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { sortOrder: 'asc' },
    });
    return cats.map(this.toCategoryDto);
  }

  async createCategory(input: { name: string; description?: string; sortOrder?: number }): Promise<PlanCategoryDto> {
    const slug = this.slugify(input.name);
    const cat = await this.prisma.planCategory.create({
      data: { name: input.name, slug, description: input.description, sortOrder: input.sortOrder ?? 0 },
    });
    return this.toCategoryDto(cat);
  }

  // ---------- Plans ----------
  async listVisible(): Promise<PlanDto[]> {
    return this.redis.cached(CACHE_KEY_PLANS, 300, async () => {
      const plans = await this.prisma.plan.findMany({
        where: { isVisible: true, status: 'ACTIVE' },
        orderBy: [{ priority: 'desc' }, { price: 'asc' }],
      });
      return plans.map(this.toDto);
    });
  }

  async listAll(query: Record<string, unknown>): Promise<PaginatedDto<PlanDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.isVisible !== undefined) where.isVisible = query.isVisible === 'true';
    if (typeof query.search === 'string' && query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [total, items] = await Promise.all([
      this.prisma.plan.count({ where }),
      this.prisma.plan.findMany({
        where,
        ...skipTake(params),
        orderBy: [{ priority: 'desc' }, { price: 'asc' }],
      }),
    ]);
    return { data: items.map(this.toDto), meta: buildMeta(total, params) };
  }

  async findBySlug(slug: string): Promise<PlanDto> {
    const plan = await this.prisma.plan.findUnique({ where: { slug } });
    if (!plan) throw BusinessException.notFound('Plan not found');
    return this.toDto(plan);
  }

  async create(input: {
    name: string;
    description?: string;
    type: PlanType;
    trafficLimitGb?: number | null;
    durationDays?: number | null;
    deviceLimit?: number;
    serverLimit?: number;
    price: string; // decimal display string
    originalPrice?: string;
    discountPercent?: number;
    currency?: string;
    priority?: number;
    isVisible?: boolean;
    countries?: string[];
    isTrial?: boolean;
    isRenewable?: boolean;
    isTransferable?: boolean;
    allowPause?: boolean;
    categoryId?: string;
    status?: string;
  }): Promise<PlanDto> {
    let slug = this.slugify(input.name);
    
    // Handle duplicate slugs by appending a numeric suffix
    let counter = 1;
    let existingSlug = await this.prisma.plan.findUnique({ where: { slug } });
    while (existingSlug) {
      slug = `${this.slugify(input.name)}-${counter}`;
      counter++;
      existingSlug = await this.prisma.plan.findUnique({ where: { slug } });
    }

    const plan = await this.prisma.plan.create({
      data: {
        name: input.name,
        slug,
        description: input.description,
        type: input.type,
        trafficLimitGb: input.trafficLimitGb != null ? BigInt(input.trafficLimitGb) : null,
        durationDays: input.durationDays ?? null,
        deviceLimit: input.deviceLimit ?? 1,
        serverLimit: input.serverLimit ?? 1,
        price: toMinor(input.price),
        originalPrice: input.originalPrice ? toMinor(input.originalPrice) : null,
        discountPercent: input.discountPercent ?? null,
        currency: input.currency ?? 'USD',
        priority: input.priority ?? 0,
        isVisible: input.isVisible ?? true,
        countries: input.countries ?? [],
        isTrial: input.isTrial ?? false,
        isRenewable: input.isRenewable ?? true,
        isTransferable: input.isTransferable ?? false,
        allowPause: input.allowPause ?? false,
        categoryId: input.categoryId ? BigInt(input.categoryId) : null,
        status: input.status ?? 'ACTIVE',
      },
    });
    await this.invalidateCache();
    return this.toDto(plan);
  }

  async update(publicId: string, input: Partial<{
    name: string; description: string; price: string; originalPrice: string;
    discountPercent: number; priority: number; isVisible: boolean; status: string;
    durationDays: number; trafficLimitGb: number; deviceLimit: number; serverLimit: number;
    countries: string[]; isTrial: boolean; isRenewable: boolean; isTransferable: boolean; allowPause: boolean;
  }>): Promise<PlanDto> {
    const existing = await this.prisma.plan.findUnique({ where: { publicId } });
    if (!existing) throw BusinessException.notFound('Plan not found');

    const data: Record<string, unknown> = {};
    if (input.name) data.name = input.name, (data as any).slug = this.slugify(input.name);
    if (input.description !== undefined) data.description = input.description;
    if (input.price) data.price = toMinor(input.price);
    if (input.originalPrice) data.originalPrice = toMinor(input.originalPrice);
    if (input.discountPercent !== undefined) data.discountPercent = input.discountPercent;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.isVisible !== undefined) data.isVisible = input.isVisible;
    if (input.status) data.status = input.status;
    if (input.durationDays !== undefined) data.durationDays = input.durationDays;
    if (input.trafficLimitGb !== undefined) data.trafficLimitGb = input.trafficLimitGb != null ? BigInt(input.trafficLimitGb) : null;
    if (input.deviceLimit !== undefined) data.deviceLimit = input.deviceLimit;
    if (input.serverLimit !== undefined) data.serverLimit = input.serverLimit;
    if (input.countries) data.countries = input.countries;
    if (input.isTrial !== undefined) data.isTrial = input.isTrial;
    if (input.isRenewable !== undefined) data.isRenewable = input.isRenewable;
    if (input.isTransferable !== undefined) data.isTransferable = input.isTransferable;
    if (input.allowPause !== undefined) data.allowPause = input.allowPause;

    const plan = await this.prisma.plan.update({ where: { publicId }, data });
    await this.invalidateCache();
    return this.toDto(plan);
  }

  async remove(publicId: string): Promise<void> {
    await this.prisma.plan.update({ where: { publicId }, data: { status: 'ARCHIVED', isVisible: false } });
    await this.invalidateCache();
  }

  async getRaw(publicId: string) {
    const plan = await this.prisma.plan.findUnique({ where: { publicId } });
    if (!plan) throw BusinessException.notFound('Plan not found');
    return plan;
  }

  priceMinor(plan: { price: MinorUnits; discountPercent?: any }): MinorUnits {
    const pct = plan.discountPercent ? Number(plan.discountPercent) : 0;
    if (pct <= 0) return plan.price;
    const factor = BigInt(Math.round(pct * 1000));
    return (plan.price * (100000n - factor)) / 100000n;
  }

  private async invalidateCache(): Promise<void> {
    await this.redis.del(CACHE_KEY_PLANS);
  }

  private slugify(s: string): string {
    return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  private toDto = (p: any): PlanDto => ({
    id: p.id.toString(),
    publicId: p.publicId,
    name: p.name,
    slug: p.slug,
    description: p.description ?? null,
    type: p.type,
    trafficLimitGb: p.trafficLimitGb != null ? p.trafficLimitGb.toString() : null,
    durationDays: p.durationDays,
    deviceLimit: p.deviceLimit,
    serverLimit: p.serverLimit,
    price: fromMinor(p.price),
    originalPrice: p.originalPrice ? fromMinor(p.originalPrice) : null,
    discountPercent: p.discountPercent ? p.discountPercent.toString() : null,
    currency: p.currency,
    priority: p.priority,
    isVisible: p.isVisible,
    countries: p.countries ?? [],
    isTrial: p.isTrial,
    isRenewable: p.isRenewable,
    isTransferable: p.isTransferable,
    allowPause: p.allowPause,
    status: p.status,
  });

  private toCategoryDto = (c: any): PlanCategoryDto => ({
    id: c.id.toString(),
    publicId: c.publicId,
    name: c.name,
    slug: c.slug,
    description: c.description ?? null,
    sortOrder: c.sortOrder,
    status: c.status,
  });
}
