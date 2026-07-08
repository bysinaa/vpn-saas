import { z } from 'zod';

export const createTicketSchema = z.object({
  subject: z.string().min(3).max(200),
  category: z.enum(['TECHNICAL', 'BILLING', 'GENERAL', 'VPN', 'ACCOUNT']).default('GENERAL'),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  message: z.string().min(1).max(5000),
  attachmentFileKey: z.string().max(256).optional(),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const replyTicketSchema = z.object({
  message: z.string().min(1).max(5000),
  attachmentFileKey: z.string().max(256).optional(),
});

export type ReplyTicketInput = z.infer<typeof replyTicketSchema>;

export const updateTicketStatusSchema = z.object({
  status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'CLOSED']),
  assigneeId: z.string().optional(),
});

export type UpdateTicketStatusInput = z.infer<typeof updateTicketStatusSchema>;
