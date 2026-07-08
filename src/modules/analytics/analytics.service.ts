import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';

export interface AnalyticsPointDto {
  date: string;
  value: number;
  dimension?: string | null;
  dimensionValue?: string | null;
}

export interface AnalyticsSeriesDto {
  metric: string;
  points: AnalyticsPointDto[];
}

export interface AnalyticsSummaryDto {
  metric: string;
  latestValue: number;
  latestDate: string;
  previousValue: number | null;
  changePercent: number | null;
}

export type MetricName =
  | 'REVENUE'
  | 'NEW_USERS'
  | 'ACTIVE_SUBS'
  | 'TRIALS'
  | 'CHURNED_SUBS'
  | 'TOTAL_USERS'
  | 'WALLET_BALANCE'
  | 'TICKETS_OPEN'
  | 'PAYMENTS_SUCCESS'
  | 'PAYMENTS_FAILED';

const VALID_METRICS: ReadonlySet<string> = new Set<MetricName>([
  'REVENUE',
  'NEW_USERS',
  'ACTIVE_SUBS',
  'TRIALS',
  'CHURNED_SUBS',
  'TOTAL_USERS',
  'WALLET_BALANCE',
  'TICKETS_OPEN',
  'PAYMENTS_SUCCESS',
  'PAYMENTS_FAILED',
]);

/**
 * AnalyticsService - aggregates platform-wide metrics into daily snapshots
 * and serves historical time-series for dashboards/reports.
 *
 * Snapshots are stored in the AnalyticsSnapshot table keyed by
 * (date, metric, dimension, dimensionValue). The snapshot job runs daily.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run the daily snapshot job. Aggregates yesterday's data for all metrics.
   * Designed to be called by a BullMQ repeatable job.
   */
  async snapshotDaily(date?: Date): Promise<void> {
    const targetDate = date ?? this.daysAgo(1);
    this.logger.log(`Running daily analytics snapshot for ${targetDate.toISOString().slice(0, 10)}`);

    const [
      revenue,
      newUsers,
      totalUsers,
      activeSubs,
      trials,
      churnedSubs,
      walletBalance,
      ticketsOpen,
      paymentsSuccess,
      paymentsFailed,
    ] = await Promise.all([
      this.sumRevenue(targetDate),
      this.countNewUsers(targetDate),
      this.countTotalUsers(targetDate),
      this.countActiveSubs(targetDate),
      this.countTrials(targetDate),
      this.countChurnedSubs(targetDate),
      this.sumWalletBalances(),
      this.countOpenTickets(targetDate),
      this.countPayments(targetDate, 'SUCCESS'),
      this.countPayments(targetDate, 'FAILED'),
    ]);

    const snapshots = [
      { metric: 'REVENUE', value: revenue },
      { metric: 'NEW_USERS', value: newUsers },
      { metric: 'TOTAL_USERS', value: totalUsers },
      { metric: 'ACTIVE_SUBS', value: activeSubs },
      { metric: 'TRIALS', value: trials },
      { metric: 'CHURNED_SUBS', value: churnedSubs },
      { metric: 'WALLET_BALANCE', value: walletBalance },
      { metric: 'TICKETS_OPEN', value: ticketsOpen },
      { metric: 'PAYMENTS_SUCCESS', value: paymentsSuccess },
      { metric: 'PAYMENTS_FAILED', value: paymentsFailed },
    ];

    for (const snap of snapshots) {
      await this.upsertSnapshot(targetDate, snap.metric, snap.value);
    }

    this.logger.log(`Daily snapshot complete: ${snapshots.length} metrics recorded`);
  }

  /**
   * Query a historical time-series for a metric.
   * Returns one point per day in the range.
   */
  async getSeries(
    metric: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<AnalyticsSeriesDto> {
    this.assertValidMetric(metric);
    const rows = await this.prisma.analyticsSnapshot.findMany({
      where: {
        metric,
        date: { gte: fromDate, lte: toDate },
        dimension: null,
      },
      orderBy: { date: 'asc' },
    });
    return {
      metric,
      points: rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        value: Number(r.value),
        dimension: r.dimension,
        dimensionValue: r.dimensionValue,
      })),
    };
  }

  /**
   * Get the latest snapshot value for a single metric with change delta
   * vs the previous data point.
   */
  async getSummary(metric: string): Promise<AnalyticsSummaryDto> {
    this.assertValidMetric(metric);
    const rows = await this.prisma.analyticsSnapshot.findMany({
      where: { metric, dimension: null },
      orderBy: { date: 'desc' },
      take: 2,
    });
    if (rows.length === 0) {
      throw BusinessException.notFound(`No analytics data for metric: ${metric}`);
    }
    const latest = rows[0];
    const previous = rows[1];
    const latestValue = Number(latest.value);
    const previousValue = previous ? Number(previous.value) : null;
    const changePercent =
      previousValue !== null && previousValue !== 0
        ? ((latestValue - previousValue) / Math.abs(previousValue)) * 100
        : null;
    return {
      metric,
      latestValue,
      latestDate: latest.date.toISOString().slice(0, 10),
      previousValue,
      changePercent: changePercent !== null
        ? Math.round(changePercent * 100) / 100
        : null,
    };
  }

  /** List all available metrics (for UI to know what to fetch). */
  listMetrics(): string[] {
    return [...VALID_METRICS];
  }

  // ---- Snapshot writers ----

  private async upsertSnapshot(
    date: Date,
    metric: string,
    value: number,
    dimension?: string,
    dimensionValue?: string,
  ): Promise<void> {
    await this.prisma.analyticsSnapshot.upsert({
      where: {
        date_metric_dimension_dimensionValue: {
          date,
          metric,
          dimension: dimension ?? '',
          dimensionValue: dimensionValue ?? '',
        },
      },
      update: { value },
      create: { date, metric, value, dimension, dimensionValue },
    });
  }

  // ---- Aggregation queries ----

  private async sumRevenue(date: Date): Promise<number> {
    const start = this.startOfDay(date);
    const end = this.endOfDay(date);
    const result = await this.prisma.payment.aggregate({
      _sum: { amount: true },
      where: { status: 'CONFIRMED', confirmedAt: { gte: start, lte: end } },
    });
    return result._sum.amount ? Number(result._sum.amount) : 0;
  }

  private async countNewUsers(date: Date): Promise<number> {
    const start = this.startOfDay(date);
    const end = this.endOfDay(date);
    return this.prisma.user.count({
      where: { createdAt: { gte: start, lte: end } },
    });
  }

  private async countTotalUsers(date: Date): Promise<number> {
    return this.prisma.user.count({
      where: { createdAt: { lte: this.endOfDay(date) } },
    });
  }

  private async countActiveSubs(date: Date): Promise<number> {
    const end = this.endOfDay(date);
    return this.prisma.subscription.count({
      where: { status: 'ACTIVE', startsAt: { lte: end } },
    });
  }

  private async countTrials(date: Date): Promise<number> {
    const end = this.endOfDay(date);
    return this.prisma.subscription.count({
      where: { status: 'TRIAL', startsAt: { lte: end } },
    });
  }

  private async countChurnedSubs(date: Date): Promise<number> {
    const start = this.startOfDay(date);
    const end = this.endOfDay(date);
    return this.prisma.subscription.count({
      where: { status: 'EXPIRED', updatedAt: { gte: start, lte: end } },
    });
  }

  private async sumWalletBalances(): Promise<number> {
    const result = await this.prisma.wallet.aggregate({
      _sum: { balance: true },
    });
    return result._sum.balance ? Number(result._sum.balance) : 0;
  }

  private async countOpenTickets(date: Date): Promise<number> {
    const end = this.endOfDay(date);
    return this.prisma.ticket.count({
      where: {
        status: { in: ['OPEN', 'PENDING_AGENT'] },
        createdAt: { lte: end },
      },
    });
  }

  private async countPayments(date: Date, status: string): Promise<number> {
    const start = this.startOfDay(date);
    const end = this.endOfDay(date);
    return this.prisma.payment.count({
      where: { status: status as any, createdAt: { gte: start, lte: end } },
    });
  }

  // ---- Helpers ----

  private assertValidMetric(metric: string): void {
    if (!VALID_METRICS.has(metric)) {
      throw new BusinessException('VALIDATION_ERROR', `Unknown metric: ${metric}`);
    }
  }

  private daysAgo(n: number): Date {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
  }

  private startOfDay(d: Date): Date {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x;
  }

  private endOfDay(d: Date): Date {
    const x = new Date(d);
    x.setUTCHours(23, 59, 59, 999);
    return x;
  }
}
