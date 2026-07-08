import { z } from 'zod';

export const updateAffiliateSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING']).optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  payoutMethod: z.enum(['WALLET', 'CRYPTO', 'MANUAL']).optional(),
  payoutDetails: z.record(z.any()).optional(),
});

export type UpdateAffiliateInput = z.infer<typeof updateAffiliateSchema>;

export const payoutCommissionSchema = z.object({
  commissionIds: z.array(z.string().min(1)).min(1),
});

export type PayoutCommissionInput = z.infer<typeof payoutCommissionSchema>;

export const resolveReferralSchema = z.object({
  referrerId: z.string().min(1),
  referredId: z.string().min(1),
  orderId: z.string().optional(),
  amountMinor: z.string().optional(),
});

export type ResolveReferralInput = z.infer<typeof resolveReferralSchema>;
