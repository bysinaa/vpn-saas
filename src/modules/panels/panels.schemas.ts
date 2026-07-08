import { z } from 'zod';

export const createPanelSchema = z.object({
  name: z.string().min(2).max(128),
  type: z.enum(['SANITY', 'MARZBAN', 'THREE_X_UI', 'CUSTOM']).default('SANITY'),
  baseUrl: z.string().url(),
  apiKey: z.string().min(8),
  isActive: z.boolean().optional(),
  extraConfig: z.record(z.any()).optional(),
});

export type CreatePanelInput = z.infer<typeof createPanelSchema>;

export const updatePanelSchema = createPanelSchema.partial();

export type UpdatePanelInput = z.infer<typeof updatePanelSchema>;
