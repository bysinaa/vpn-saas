import { z } from 'zod';

export const createOrderSchema = z.object({
  planPublicId: z.string().uuid('Invalid plan id'),
  type: z.enum(['NEW', 'RENEW', 'EXTEND']).optional(),
  quantity: z.number().int().min(1).max(50).optional(),
  giftForUserPublicId: z.string().uuid().optional(),
  paymentMethod: z
    .enum(['WALLET', 'ONLINE', 'CARD_TO_CARD', 'CRYPTO', 'VOUCHER'])
    .optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const payOrderSchema = z.object({
  // wallet payment has no extra body; gateway redirects handled by Payments module
  method: z.enum(['WALLET']).optional(),
});

export type PayOrderInput = z.infer<typeof payOrderSchema>;
