import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { fromMinor } from '@/common/utils/money.util';

export interface DashboardStats {
  users: {
    total: number;
    active: number;
    banned: number;
    newToday: number;
    newThisMonth: number;
  };
  revenue: {
    today: string;
    thisMonth: string;
    total: string;
    currency: string;
  };
  subscriptions: {
    total: number;
    active: number;
    expired: number;
    suspended: number;
    trial: number;
    paused: number;
  };
  orders: {
    total: number;
    pending: number;
    completed: number;
    cancelled: number;
  };
  payments: {
    total: number;
    pending: number;
    confirmed: number;
    failed: number;
    pendingReceipts: number;
  };
  servers: {
    total: number;
    active: number;
    healthy: number;
  };
  tickets: {
    total: number;
    open: number;
    pending: number;
    resolved: number;
    closed: number;
  };
}

export interface RevenuePoint {
  date: string;
  amount: string;
  count: number;
}

export interface GrowthPoint {
  date: string;
  count: number;
}

interface StatusGroup {
  status: string;
  _count: number;
}

/**
 * AdminService - read-only aggregation for the admin dashboard.
 * Uses raw SQL aggregation for performance on large datasets.
 */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboardStats(): Promise<DashboardStats> {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalUsers,
      activeUsers,
      bannedUsers,
      newToday,
      newThisMonth,
      revenueToday,
      revenueMonth,
      revenueTotal,
      subTotal,
      orderTotal,
      paymentTotal,
      ticketTotal,
      subGroups,
      orderGroups,
      paymentGroups,
      ticketGroups,
      pendingReceipts,
      serverStats,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { status: 'ACTIVE', deletedAt: null } }),
      this.prisma.user.count({ where: { status: 'BANNED', deletedAt: null } }),
      this.prisma.user.count({ where: { createdAt: { gte: startOfToday }, deletedAt: null } }),
      this.prisma.user.count({ where: { createdAt: { gte: startOfMonth }, deletedAt: null } }),
      this.sumPayments(startOfToday),
      this.sumPayments(startOfMonth),
      this.sumPayments(undefined),
      this.prisma.subscription.count(),
      this.prisma.order.count(),
      this.prisma.payment.count(),
      this.prisma.ticket.count(),
      this.prisma.subscription.groupBy({ by: ['status'], _count: true }),
      this.prisma.order.groupBy({ by: ['status'], _count: true }),
      this.prisma.payment.groupBy({ by: ['status'], _count: true }),
      this.prisma.ticket.groupBy({ by: ['status'], _count: true }),
      this.prisma.receipt.count({ where: { status: 'PENDING' } }),
      Promise.all([
        this.prisma.server.count(),
        this.prisma.server.count({ where: { status: 'ONLINE' } }),
        this.prisma.vpnPanel.count({ where: { healthStatus: 'HEALTHY' } }),
      ]),
    ]);

    return {
      users: {
        total: totalUsers,
        active: activeUsers,
        banned: bannedUsers,
        newToday,
        newThisMonth,
      },
      revenue: {
        today: fromMinor(revenueToday),
        thisMonth: fromMinor(revenueMonth),
        total: fromMinor(revenueTotal),
        currency: 'IRR',
      },
      subscriptions: {
        total: subTotal,
        active: this.pick(subGroups, 'ACTIVE'),
        expired: this.pick(subGroups, 'EXPIRED'),
        suspended: this.pick(subGroups, 'SUSPENDED'),
        trial: this.pick(subGroups, 'TRIAL'),
        paused: this.pick(subGroups, 'PAUSED'),
      },
      orders: {
        total: orderTotal,
        pending: this.pick(orderGroups, 'PENDING'),
        completed: this.pick(orderGroups, 'COMPLETED'),
        cancelled: this.pick(orderGroups, 'CANCELLED'),
      },
      payments: {
        total: paymentTotal,
        pending: this.pick(paymentGroups, 'PENDING'),
        confirmed: this.pick(paymentGroups, 'CONFIRMED'),
        failed: this.pick(paymentGroups, 'FAILED'),
        pendingReceipts,
      },
      servers: { total: serverStats[0], active: serverStats[1], healthy: serverStats[2] },
      tickets: {
        total: ticketTotal,
        open: this.pick(ticketGroups, 'OPEN'),
        pending: this.pick(ticketGroups, 'PENDING'),
        resolved: this.pick(ticketGroups, 'RESOLVED'),
        closed: this.pick(ticketGroups, 'CLOSED'),
      },
    };
  }

  /** Daily revenue for the last N days (for charts). */
  async getRevenueSeries(days = 30): Promise<RevenuePoint[]> {
    const since = new Date(Date.now() - days * 86400000);
    const rows = await this.prisma.$queryRaw<Array<{ date: string; amount: bigint; count: bigint }>>`
      SELECT DATE("confirmedAt") AS date,
             SUM(amount) AS amount,
             COUNT(*) AS count
      FROM payments
      WHERE status = 'CONFIRMED' AND "confirmedAt" >= ${since}
      GROUP BY DATE("confirmedAt")
      ORDER BY date ASC
    `;
    return rows.map((r: { date: string; amount: bigint; count: bigint }) => ({
      date: r.date,
      amount: fromMinor(r.amount),
      count: Number(r.count),
    }));
  }

  /** Daily user signups for the last N days. */
  async getUserGrowthSeries(days = 30): Promise<GrowthPoint[]> {
    const since = new Date(Date.now() - days * 86400000);
    const rows = await this.prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
      SELECT DATE("createdAt") AS date, COUNT(*) AS count
      FROM users
      WHERE "createdAt" >= ${since} AND "deletedAt" IS NULL
      GROUP BY DATE("createdAt")
      ORDER BY date ASC
    `;
    return rows.map((r: { date: string; count: bigint }) => ({
      date: r.date,
      count: Number(r.count),
    }));
  }

  private pick(groups: StatusGroup[], status: string): number {
    return groups.find((g) => g.status === status)?._count ?? 0;
  }

  private async sumPayments(since?: Date): Promise<bigint> {
    const result = await this.prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        status: 'CONFIRMED',
        ...(since ? { confirmedAt: { gte: since } } : {}),
      },
    });
    return result._sum.amount ?? 0n;
  }
}
