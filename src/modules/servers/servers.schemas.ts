import { z } from 'zod';

export const createCountrySchema = z.object({
  code: z.string().min(2).max(2),
  name: z.string().min(2).max(64),
  flagEmoji: z.string().max(16).optional(),
});

export type CreateCountryInput = z.infer<typeof createCountrySchema>;

export const updateCountrySchema = createCountrySchema.partial();

export type UpdateCountryInput = z.infer<typeof updateCountrySchema>;

export const createCitySchema = z.object({
  countryId: z.string().min(1),
  name: z.string().min(2).max(64),
});

export type CreateCityInput = z.infer<typeof createCitySchema>;

export const createServerSchema = z.object({
  cityId: z.string().min(1),
  name: z.string().min(2).max(128),
  host: z.string().min(3).max(128),
  port: z.number().int().min(1).max(65535),
  panelId: z.string().min(1),
  status: z.enum(['ACTIVE', 'INACTIVE', 'MAINTENANCE']).optional(),
  maxLoad: z.number().int().min(1).max(100000).optional(),
});

export type CreateServerInput = z.infer<typeof createServerSchema>;

export const updateServerSchema = createServerSchema.partial();

export type UpdateServerInput = z.infer<typeof updateServerSchema>;

export const createInboundSchema = z.object({
  serverId: z.string().min(1),
  panelId: z.string().min(1),
  inboundId: z.string().min(1),
  protocol: z.enum(['VMESS', 'VLESS', 'TROJAN', 'SHADOWSOCKS']),
  port: z.number().int().min(1).max(65535),
  settings: z.record(z.any()).optional(),
});

export type CreateInboundInput = z.infer<typeof createInboundSchema>;
