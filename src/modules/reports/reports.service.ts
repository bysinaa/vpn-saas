import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { STORAGE, type IStorage } from '@/common/storage/storage.interface';
import { BusinessException } from '@/common/exceptions/business.exception';
import { randomUUID } from 'node:crypto';

export interface ReportResult {
  fileKey: string;
  downloadUrl: string;
  rows: number;
  format: string;
  generatedAt: Date;
}

/**
 * ReportsService - generates exportable platform reports (CSV) and stores
 * them in S3-compatible storage, returning a signed download URL.
 *
 * Reports are async-friendly: heavy aggregation is done in SQL, results are
 * streamed to a CSV buffer, then uploaded. For very large reports this
 * should be moved to a background job; the current implementation is
 * suitable for moderate data volumes.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: IStorage,
  ) {}

  async revenueReport(
    from: Date,
    to: Date,
    groupBy: 'day' | 'month',
  ): Promise<ReportResult> {
    const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
    const trunc = groupBy === 'day' ? 'day' : 'month';
    // Payment uses `confirmedAt` (not settledAt) and PaymentStatus CONFIRMED
    // (not SUCCESS).
    const rows = await this.prisma.$queryRaw<
      Array<{ period: Date; total_amount: bigint; count: bigint }>
    >`
      SELECT
        date_trunc(${trunc}, "confirmedAt") AS period,
        COALESCE(SUM(amount), 0) AS total_amount,
        COUNT(*) AS count
      FROM payments
      WHERE status = 'CONFIRMED'
        AND "confirmedAt" BETWEEN ${from} AND ${to}
      GROUP BY period
      ORDER BY period ASC
    `;

    const csv = this.buildCsv(
      ['period', 'total_amount_minor', 'transaction_count'],
      rows.map((r) => [
        r.period.toISOString().slice(0, dateFormat.length),
        r.total_amount.toString(),
        r.count.toString(),
      ]),
    );

    return this.uploadReport('revenue', csv, rows.length);
  }

  async subscriptionsReport(
    from: Date | undefined,
    to: Date | undefined,
    status: string | undefined,
  ): Promise<ReportResult> {
    // Cast where as any to avoid Prisma enum/structural mismatches.
    const where: any = {};
    if (status) where.status = status;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    const subscriptions = await this.prisma.subscription.findMany({
      where,
      select: {
        publicId: true,
        status: true,
        startsAt: true,
        expiresAt: true,
        trafficLimitBytes: true,
        usedTrafficBytes: true,
        user: { select: { telegramId: true, username: true } },
        plan: { select: { slug: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    const csv = this.buildCsv(
      ['subscription_id', 'status', 'plan_slug', 'plan_name', 'start_date', 'end_date', 'traffic_limit_bytes', 'used_bytes', 'user_telegram_id', 'user_username'],
      subscriptions.map((s) => [
        s.publicId,
        s.status,
        s.plan.slug,
        s.plan.name,
        s.startsAt.toISOString(),
        s.expiresAt ? s.expiresAt.toISOString() : '',
        s.trafficLimitBytes?.toString() ?? '0',
        s.usedTrafficBytes.toString(),
        s.user.telegramId?.toString() ?? '',
        s.user.username ?? '',
      ]),
    );

    return this.uploadReport('subscriptions', csv, subscriptions.length);
  }

  async usersReport(
    from: Date | undefined,
    to: Date | undefined,
    status: string | undefined,
  ): Promise<ReportResult> {
    // Cast where as any to avoid Prisma enum/structural mismatches.
    const where: any = { deletedAt: null };
    if (status) where.status = status;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    // Wallet uses `balance` (not balanceMinor).
    const users = await this.prisma.user.findMany({
      where,
      select: {
        publicId: true,
        telegramId: true,
        username: true,
        firstName: true,
        lastName: true,
        status: true,
        createdAt: true,
        wallet: { select: { balance: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    const csv = this.buildCsv(
      ['user_id', 'telegram_id', 'username', 'first_name', 'last_name', 'status', 'wallet_balance_minor', 'created_at'],
      users.map((u) => [
        u.publicId,
        u.telegramId?.toString() ?? '',
        u.username ?? '',
        u.firstName ?? '',
        u.lastName ?? '',
        u.status,
        u.wallet?.balance.toString() ?? '0',
        u.createdAt.toISOString(),
      ]),
    );

    return this.uploadReport('users', csv, users.length);
  }

  // ---- CSV building ----

  /**
   * Minimal CSV serializer that escapes fields containing commas, quotes,
   * or newlines by wrapping in double quotes and doubling internal quotes.
   */
  private buildCsv(headers: string[], rows: string[][]): string {
    const escape = (val: string): string => {
      if (/[",\n\r]/.test(val)) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };
    const lines = [headers.map(escape).join(',')];
    for (const row of rows) {
      lines.push(row.map(escape).join(','));
    }
    return lines.join('\r\n');
  }

  private async uploadReport(
    type: string,
    csv: string,
    rowCount: number,
  ): Promise<ReportResult> {
    if (rowCount === 0) {
      throw BusinessException.notFound(`No data found for ${type} report`);
    }
    const key = `reports/${type}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.csv`;
    const uploaded = await this.storage.upload({
      key,
      body: Buffer.from(csv, 'utf-8'),
      mimeType: 'text/csv',
      isPublic: false,
    });
    const downloadUrl = await this.storage.getSignedUrl(key, 3600);
    this.logger.log(`Generated ${type} report: ${rowCount} rows -> ${key}`);
    return {
      fileKey: uploaded.key,
      downloadUrl,
      rows: rowCount,
      format: 'csv',
      generatedAt: new Date(),
    };
  }
}
