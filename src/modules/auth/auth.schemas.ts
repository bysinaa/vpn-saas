import { z } from 'zod';

/**
 * Zod schemas for auth input validation. Keeps validation close to the
 * domain and decoupled from the transport layer.
 */
export const AuthSchemas = {
  register: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(128),
    username: z.string().min(3).max(32).optional(),
  }),

  login: z
    .object({
      email: z.string().email().optional(),
      telegramId: z.string().optional(),
      password: z.string().min(1).optional(),
    })
    .refine((v) => v.email || v.telegramId, {
      message: 'Either email or telegramId is required',
    })
    .refine((v) => v.password, { message: 'password is required' }),

  refresh: z.object({
    refreshToken: z.string().min(10),
  }),

  telegramLogin: z.object({
    telegramId: z.string().min(1),
    username: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    languageCode: z.string().optional(),
    referralCode: z.string().optional(),
    deviceFingerprint: z.string().optional(),
    initaData: z.string().optional(),
  }),
};

export type RegisterDto = z.infer<typeof AuthSchemas.register>;
export type LoginDto = z.infer<typeof AuthSchemas.login>;
export type TelegramLoginDto = z.infer<typeof AuthSchemas.telegramLogin>;
