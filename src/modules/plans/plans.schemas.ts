import { z } from 'zod';

const planType = z.enum([
  'TRAFFIC', 'TIME', 'UNLIMITED', 'COMBINATION', 'MANUAL',
  'AUTOMATIC', 'TRIAL', 'GIFT', 'FAMILY', 'BUSINESS', 'MULTI_DEVICE',
]);

export const PlansSchemas = {
  create: z.object({
    name: z.string().min(2).max(80),
    description: z.string().optional(),
    type: planType,
    trafficLimitGb: z.number().nonnegative().nullable().optional(),
    durationDays: z.number().int().positive().nullable().optional(),
    deviceLimit: z.number().int().positive().default(1),
    serverLimit: z.number().int().positive().default(1),
    price: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Invalid price'),
    originalPrice: z.string().optional(),
    discountPercent: z.number().min(0).max(100).optional(),
    currency: z.string().default('USD'),
    priority: z.number().int().default(0),
    isVisible: z.boolean().default(true),
    countries: z.array(z.string()).default([]),
    isTrial: z.boolean().default(false),
    isRenewable: z.boolean().default(true),
    isTransferable: z.boolean().default(false),
    allowPause: z.boolean().default(false),
    categoryId: z.string().optional(),
    status: z.string().default('ACTIVE'),
  }),

  update: z.object({
    name: z.string().min(2).max(80).optional(),
    description: z.string().optional(),
    price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    originalPrice: z.string().optional(),
    discountPercent: z.number().min(0).max(100).optional(),
    priority: z.number().int().optional(),
    isVisible: z.boolean().optional(),
    status: z.string().optional(),
    durationDays: z.number().int().positive().nullable().optional(),
    trafficLimitGb: z.number().nonnegative().nullable().optional(),
    deviceLimit: z.number().int().positive().optional(),
    serverLimit: z.number().int().positive().optional(),
    countries: z.array(z.string()).optional(),
    isTrial: z.boolean().optional(),
    isRenewable: z.boolean().optional(),
    isTransferable: z.boolean().optional(),
    allowPause: z.boolean().optional(),
  }),

  createCategory: z.object({
    name: z.string().min(2).max(80),
    description: z.string().optional(),
    sortOrder: z.number().int().default(0),
  }),
};

export type CreatePlanDto = z.infer<typeof PlansSchemas.create>;
export type UpdatePlanDto = z.infer<typeof PlansSchemas.update>;
