import { z } from 'zod';

export const upsertSettingSchema = z.object({
  key: z.string().min(1).max(255),
  value: z.string(),
  category: z.string().max(100).optional().default('GENERAL'),
  type: z.enum(['STRING', 'NUMBER', 'BOOLEAN', 'JSON']).optional().default('STRING'),
  isPublic: z.boolean().optional().default(false),
  editable: z.boolean().optional().default(true),
  description: z.string().max(1000).optional(),
});

export const updateFeatureFlagSchema = z.object({
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  description: z.string().max(1000).optional(),
});

export type UpsertSettingInput = z.infer<typeof upsertSettingSchema>;
export type UpdateFeatureFlagInput = z.infer<typeof updateFeatureFlagSchema>;
