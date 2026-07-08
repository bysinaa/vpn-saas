import { z } from 'zod';

export const UsersSchemas = {
  updateProfile: z.object({
    username: z.string().min(3).max(32).optional(),
    firstName: z.string().max(64).optional(),
    lastName: z.string().max(64).optional(),
    phone: z.string().max(20).optional(),
    language: z.enum(['EN', 'FA', 'RU', 'AR', 'TR']).optional(),
    avatarUrl: z.string().url().optional(),
  }),

  changeStatus: z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED', 'PENDING']),
  }),

  changeRole: z.object({
    role: z.enum(['ADMIN', 'OPERATOR', 'SUPPORT', 'USER']),
  }),
};

export type UpdateProfileDto = z.infer<typeof UsersSchemas.updateProfile>;
