import { z } from 'zod';

export const revenueReportSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  groupBy: z.enum(['day', 'month']).optional().default('day'),
});

export const subscriptionsReportSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: z
    .enum(['ACTIVE', 'EXPIRED', 'SUSPENDED', 'PAUSED', 'TRIAL', 'CANCELLED'])
    .optional(),
});

export const usersReportSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']).optional(),
});

export type RevenueReportInput = z.infer<typeof revenueReportSchema>;
export type SubscriptionsReportInput = z.infer<typeof subscriptionsReportSchema>;
export type UsersReportInput = z.infer<typeof usersReportSchema>;

export type ReportType = 'revenue' | 'subscriptions' | 'users';
