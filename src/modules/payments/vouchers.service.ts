import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/redis/redis.service';
import { AuditService } from '@/common/audit/audit.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { randomCode } from '@/common/utils/crypto.util';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { VpnService } from '../vpn/vpn.service';
import type { Voucher } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export interface VoucherDto {
  id: string;
  publicId: string;
  code: string;
  type: string;
  amount: string | null;
  planId: string | null;
  planName: string | null;
  trafficLimitGb: string | null;
  durationDays: number | null;
  serverGroupId: string | null;
  deviceLimit: number | null;
  maxRedemptions: number;
  redemptions: number;
  expiresAt: Date | null;
  redeemedById: string | null;
  usedByTelegramId: string | null;
  usedByIp: string | null;
  redeemedAt: Date | null;
  isActive: boolean;
  createdById: string | null;
  batchId: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RedeemResult {
  voucher: VoucherDto;
  subscriptionId: string;
  subscriptionPublicId: string;
  planName: string;
}

/**
 * Voucher code length — spec #5 requires 10-char uppercase alphanumeric
 * codes (e.g. A9K4M8Q2XZ).
 */
const VOUCHER_CODE_LENGTH = 10;
const CACHE_KEY = 'vouchers:active';

/**
 * VouchersService (spec #5) — vouchers activate VPN subscriptions DIRECTLY,
 * not by crediting the wallet. The admin generates voucher codes (random
 * 10-char uppercase alphanumeric), binds them to a plan (optionally overriding
 * traffic / duration / server group), and distributes them. When a user
 * redeems a code the service:
 *
 *   1. Validates the voucher (exists, active, not expired, not used up)
 *   2. Opens a DB transaction (rollback on any failure)
 *   3. Provisions a VPN subscription via SubscriptionsService.provision(tx)
 *   4. Marks the voucher USED (stores redeemer id / telegramId / ip / time)
 *   5. After commit, enqueues Sanity panel user creation via VpnService
 *   6. Audit-logs the REDEEM action
 *
 * A redeemed voucher is NEVER reusable.
 */
@Injectable()
export class VouchersService {
  private readonly logger = new Logger(VouchersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly subscriptions: SubscriptionsService,
    private readonly vpn: VpnService,
  ) {}

  // ---------------------------------------------------------------------------
  // Admin: generate voucher codes
  // ---------------------------------------------------------------------------

  /**
   * Generate one or more voucher codes. All codes in a single call share a
   * `batchId` so the admin can manage them as a group.
   */
  async generate(
    input: {
      planId?: bigint;
      type?: 'PLAN' | 'BALANCE';
      amount?: bigint; // only for BALANCE type
      trafficLimitGb?: bigint; // override plan.trafficLimitGb
      durationDays?: number; // override plan.durationDays
      serverGroupId?: string; // override plan.serverGroupId
      deviceLimit?: number;
      maxRedemptions?: number; // default 1 (one-time use)
      expiresAt?: Date;
      note?: string;
      count?: number; // how many codes to mint (default 1)
    },
    adminId?: bigint,
  ): Promise<VoucherDto[]> {
    const count = Math.min(Math.max(input.count ?? 1, 1), 500);
    const batchId = randomUUID();
    const type = input.type ?? 'PLAN';

    // Validate plan binding for PLAN-type vouchers.
    let plan: { id: bigint; name: string; isEnabled: boolean } | null = null;
    if (type === 'PLAN') {
      if (!input.planId) {
        throw BusinessException.conflict('PLAN voucher requires a planId');
      }
      plan = await this.prisma.plan.findUnique({
        where: { id: input.planId },
        select: { id: true, name: true, isEnabled: true },
      });
      if (!plan) throw BusinessException.notFound('Plan not found');
      if (!plan.isEnabled) {
        throw BusinessException.conflict('Cannot bind voucher to a disabled plan');
      }
    }

    // Mint unique codes with retry on collision (extremely unlikely).
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      let code = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = randomCode(VOUCHER_CODE_LENGTH);
        const exists = await this.prisma.voucher.findUnique({
          where: { code: candidate },
          select: { id: true },
        });
        if (!exists) {
          code = candidate;
          break;
        }
      }
      if (!code) {
        throw BusinessException.conflict('Failed to generate a unique voucher code');
      }
      codes.push(code);
    }

    const created = await this.prisma.voucher.createMany({
      data: codes.map((code) => ({
        publicId: randomUUID(),
        code,
        type,
        amount: type === 'BALANCE' ? input.amount ?? null : null,
        planId: type === 'PLAN' ? plan!.id : null,
        trafficLimitGb: input.trafficLimitGb ?? null,
        durationDays: input.durationDays ?? null,
        serverGroupId: input.serverGroupId ?? null,
        deviceLimit: input.deviceLimit ?? null,
        maxRedemptions: input.maxRedemptions ?? 1,
        expiresAt: input.expiresAt ?? null,
        createdById: adminId ?? null,
        batchId,
        note: input.note ?? null,
      })),
    });

    // Fetch the created rows to return as DTOs (createMany doesn't return rows).
    const vouchers = await this.prisma.voucher.findMany({
      where: { batchId },
      orderBy: { id: 'asc' },
    });

    await this.invalidate();
    await this.audit.log({
      userId: adminId,
      action: 'CREATE',
      resource: 'vouchers',
      resourceId: batchId,
      after: {
        count: created.count,
        codes,
        type,
        planId: plan?.id.toString() ?? null,
        planName: plan?.name ?? null,
      },
    });
    this.logger.log(`Admin ${adminId ?? '?'} generated ${created.count} voucher(s) batch=${batchId}`);

    return vouchers.map((v) => this.toDto(v));
  }

  // ---------------------------------------------------------------------------
  // User: redeem a voucher code → activate VPN subscription
  // ---------------------------------------------------------------------------

  /**
   * Redeem a voucher code. This is the critical transactional operation:
   * everything inside the DB transaction either fully succeeds or rolls back.
   * VPN panel user creation is enqueued AFTER the transaction commits so a
   * panel failure never leaves the DB in an inconsistent state.
   */
  async redeem(
    code: string,
    params: { userId: bigint; telegramId: string; ip?: string },
  ): Promise<RedeemResult> {
    const normalizedCode = (code || '').trim().toUpperCase();

    // Pre-flight validation (outside tx for fast-fail).
    const voucher = await this.prisma.voucher.findUnique({
      where: { code: normalizedCode },
      include: { plan: true },
    });
    if (!voucher || !voucher.isActive) {
      throw new BusinessException('VOUCHER_INVALID', 'Invalid or inactive voucher code');
    }
    if (voucher.expiresAt && voucher.expiresAt < new Date()) {
      throw new BusinessException('VOUCHER_EXPIRED', 'Voucher has expired');
    }
    if (voucher.redemptions >= voucher.maxRedemptions) {
      throw new BusinessException('VOUCHER_INVALID', 'Voucher redemption limit reached');
    }
    if (voucher.redeemedById && voucher.maxRedemptions <= 1) {
      throw new BusinessException('VOUCHER_INVALID', 'Voucher already redeemed');
    }

    if (voucher.type !== 'PLAN') {
      throw new BusinessException(
        'VOUCHER_INVALID',
        'This voucher type is not supported for direct activation',
      );
    }
    if (!voucher.planId || !voucher.plan) {
      throw new BusinessException('VOUCHER_INVALID', 'Voucher has no bound plan');
    }
    if (!voucher.plan.isEnabled) {
      throw new BusinessException('VOUCHER_INVALID', 'The plan bound to this voucher is disabled');
    }

    // Critical section — DB transaction with rollback on failure.
    const { subscription, updatedVoucher } = await this.prisma.withTransaction(async (tx) => {
      // Re-read inside the tx to get the latest redemptions count (race safety).
      const fresh = await tx.voucher.findUnique({
        where: { id: voucher.id },
        select: { redemptions: true, redeemedById: true, isActive: true },
      });
      if (!fresh || !fresh.isActive) {
        throw new BusinessException('VOUCHER_INVALID', 'Voucher is no longer active');
      }
      if (fresh.redemptions >= voucher.maxRedemptions) {
        throw new BusinessException('VOUCHER_INVALID', 'Voucher redemption limit reached');
      }

      // Provision the subscription inside this transaction.
      const sub = await this.subscriptions.provision({
        userId: params.userId,
        planId: voucher.planId!,
        type: 'NEW' as any,
        tx: tx as any,
      });

      // Mark the voucher as USED — store full tracking info.
      const newRedemptions = fresh.redemptions + 1;
      const exhausted = newRedemptions >= voucher.maxRedemptions;
      const updated = await tx.voucher.update({
        where: { id: voucher.id },
        data: {
          redeemedById: params.userId,
          usedByTelegramId: params.telegramId,
          usedByIp: params.ip ?? null,
          redeemedAt: new Date(),
          redemptions: newRedemptions,
          isActive: !exhausted, // auto-disable when fully redeemed
        },
        include: { plan: true },
      });

      return { subscription: sub, updatedVoucher: updated };
    });

    // After commit: enqueue Sanity panel user creation (async, resilient).
    try {
      await this.vpn.createVpnUserForSubscription(BigInt(subscription.id));
    } catch (err) {
      // Panel creation is retried by the queue; do NOT fail the redemption.
      this.logger.error(
        `Voucher redeemed (sub ${subscription.id}) but panel enqueue failed: ${(err as Error).message}`,
      );
    }

    // Audit log (never throws).
    await this.audit.log({
      userId: params.userId,
      action: 'REDEEM',
      resource: 'vouchers',
      resourceId: voucher.publicId,
      ip: params.ip,
      after: {
        code: voucher.code,
        subscriptionId: subscription.id,
        subscriptionPublicId: subscription.publicId,
        planId: voucher.planId?.toString() ?? null,
        planName: voucher.plan?.name ?? null,
        telegramId: params.telegramId,
      },
    });

    await this.invalidate();
    this.logger.log(
      `Voucher ${voucher.code} redeemed by user ${params.userId} (telegram=${params.telegramId}) → subscription ${subscription.id}`,
    );

    return {
      voucher: this.toDto(updatedVoucher),
      subscriptionId: subscription.id,
      subscriptionPublicId: subscription.publicId,
      planName: voucher.plan?.name ?? '',
    };
  }

  // ---------------------------------------------------------------------------
  // Admin: list / lookup / disable
  // ---------------------------------------------------------------------------

  async listAll(query: Record<string, unknown>): Promise<PaginatedDto<VoucherDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.isActive !== undefined) where.isActive = query.isActive === 'true' || query.isActive === true;
    if (query.type) where.type = query.type;
    if (query.batchId) where.batchId = query.batchId;
    if (query.planId) where.planId = BigInt(query.planId as string);
    if (query.search) {
      where.OR = [
        { code: { contains: query.search as string, mode: 'insensitive' } },
        { note: { contains: query.search as string, mode: 'insensitive' } },
        { batchId: { contains: query.search as string, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.voucher.count({ where }),
      this.prisma.voucher.findMany({
        where,
        include: { plan: { select: { name: true } } },
        ...skipTake(params),
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      data: items.map((v) => this.toDtoWithPlan(v, v.plan?.name ?? null)),
      meta: buildMeta(total, params),
    };
  }

  async getByCode(code: string): Promise<VoucherDto> {
    const voucher = await this.prisma.voucher.findUnique({
      where: { code: (code || '').trim().toUpperCase() },
      include: { plan: { select: { name: true } } },
    });
    if (!voucher) throw BusinessException.notFound('Voucher not found');
    return this.toDtoWithPlan(voucher, voucher.plan?.name ?? null);
  }

  async getByPublicId(publicId: string): Promise<VoucherDto> {
    const voucher = await this.prisma.voucher.findUnique({
      where: { publicId },
      include: { plan: { select: { name: true } } },
    });
    if (!voucher) throw BusinessException.notFound('Voucher not found');
    return this.toDtoWithPlan(voucher, voucher.plan?.name ?? null);
  }

  /** Admin disables a voucher so it can no longer be redeemed. */
  async disable(publicId: string, adminId?: bigint): Promise<VoucherDto> {
    const existing = await this.prisma.voucher.findUnique({ where: { publicId } });
    if (!existing) throw BusinessException.notFound('Voucher not found');
    const updated = await this.prisma.voucher.update({
      where: { publicId },
      data: { isActive: false },
    });
    await this.invalidate();
    await this.audit.log({
      userId: adminId,
      action: 'UPDATE',
      resource: 'vouchers',
      resourceId: publicId,
      before: this.toDto(existing),
      after: this.toDto(updated),
      metadata: { action: 'disable' },
    });
    return this.toDto(updated);
  }

  /** Admin updates a voucher's metadata (note, expiresAt, maxRedemptions). */
  async update(
    publicId: string,
    input: Partial<{ note: string | null; expiresAt: Date | null; maxRedemptions: number }>,
    adminId?: bigint,
  ): Promise<VoucherDto> {
    const existing = await this.prisma.voucher.findUnique({ where: { publicId } });
    if (!existing) throw BusinessException.notFound('Voucher not found');
    const data: Record<string, unknown> = {};
    if (input.note !== undefined) data.note = input.note;
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;
    if (input.maxRedemptions !== undefined) data.maxRedemptions = input.maxRedemptions;
    const updated = await this.prisma.voucher.update({ where: { publicId }, data });
    await this.invalidate();
    await this.audit.log({
      userId: adminId,
      action: 'UPDATE',
      resource: 'vouchers',
      resourceId: publicId,
      before: this.toDto(existing),
      after: this.toDto(updated),
    });
    return this.toDto(updated);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async invalidate(): Promise<void> {
    await this.redis.del(CACHE_KEY);
  }

  private toDto(v: Voucher): VoucherDto {
    return {
      id: v.id.toString(),
      publicId: v.publicId,
      code: v.code,
      type: v.type,
      amount: v.amount != null ? v.amount.toString() : null,
      planId: v.planId != null ? v.planId.toString() : null,
      planName: null,
      trafficLimitGb: v.trafficLimitGb != null ? v.trafficLimitGb.toString() : null,
      durationDays: v.durationDays,
      serverGroupId: v.serverGroupId,
      deviceLimit: v.deviceLimit,
      maxRedemptions: v.maxRedemptions,
      redemptions: v.redemptions,
      expiresAt: v.expiresAt,
      redeemedById: v.redeemedById != null ? v.redeemedById.toString() : null,
      usedByTelegramId: v.usedByTelegramId,
      usedByIp: v.usedByIp,
      redeemedAt: v.redeemedAt,
      isActive: v.isActive,
      createdById: v.createdById != null ? v.createdById.toString() : null,
      batchId: v.batchId,
      note: v.note,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    };
  }

  /** toDto variant that includes the plan name from a joined query. */
  private toDtoWithPlan(v: Voucher, planName: string | null): VoucherDto {
    return {
      ...this.toDto(v),
      planName,
    };
  }
}
