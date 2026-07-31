import { z } from 'zod';

export const createBankCardSchema = z.object({
  cardNumber: z.string().min(4).max(64),
  cardHolder: z.string().min(2).max(100),
  bankName: z.string().min(2).max(100),
  shebaNumber: z.string().min(16).max(34).optional(), // flexible length for IBAN-like strings
  label: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

export type CreateBankCardInput = z.infer<typeof createBankCardSchema>;

export const updateBankCardSchema = createBankCardSchema.partial();
export type UpdateBankCardInput = z.infer<typeof updateBankCardSchema>;