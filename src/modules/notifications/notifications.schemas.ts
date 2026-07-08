import { z } from 'zod';

export const BroadcastSchemas = {
  create: z.object({
    message: z.string().min(1).max(4096),
    targetRole: z.enum(['ALL', 'USER', 'ADMIN', 'OPERATOR', 'SUPER_ADMIN']).optional().default('ALL'),
  }),
};