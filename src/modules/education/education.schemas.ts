import { z } from 'zod';

export const createArticleSchema = z.object({
  topic: z.enum(['GETTING_STARTED', 'TROUBLESHOOTING', 'SETUP_GUIDE', 'FAQ', 'SECURITY', 'ADVANCED']),
  title: z.string().min(3).max(200),
  slug: z.string().min(3).max(200).optional(),
  content: z.string().min(10),
  summary: z.string().max(500).optional(),
  videoUrl: z.string().url().optional(),
  coverImageKey: z.string().max(256).optional(),
  sortOrder: z.number().int().min(0).default(0),
  isPublished: z.boolean().default(true),
  tags: z.array(z.string()).optional(),
});

export type CreateArticleInput = z.infer<typeof createArticleSchema>;

export const updateArticleSchema = createArticleSchema.partial();

export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;
