import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';
import { randomUUID } from 'node:crypto';

export interface ArticleDto {
  id: string;
  publicId: string;
  topic: string;
  title: string;
  slug: string;
  summary: string | null;
  content: string;
  videoUrl: string | null;
  coverImageKey: string | null;
  sortOrder: number;
  isPublished: boolean;
  tags: string[];
  readCount: number;
  helpfulCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArticleSummaryDto {
  id: string;
  publicId: string;
  topic: string;
  title: string;
  slug: string;
  summary: string | null;
  coverImageKey: string | null;
  sortOrder: number;
  readCount: number;
}

/**
 * EducationService - knowledge base / help center.
 * Articles are organized by topic and track per-user progress so we can
 * surface "getting started" checklists and completion rates.
 */
@Injectable()
export class EducationService {
  constructor(private readonly prisma: PrismaService) {}

  async listPublished(topic?: string): Promise<ArticleSummaryDto[]> {
    const where: Record<string, unknown> = { isVisible: true };
    if (topic) where.topic = topic;
    const articles = await this.prisma.educationArticle.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return articles.map((a) => this.toSummaryDto(a));
  }

  async listAll(query: Record<string, unknown>): Promise<PaginatedDto<ArticleDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.topic) where.topic = query.topic;
    if (query.isPublished !== undefined) where.isVisible = query.isPublished === 'true';
    const [total, items] = await Promise.all([
      this.prisma.educationArticle.count({ where }),
      this.prisma.educationArticle.findMany({
        where,
        ...skipTake(params),
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return { data: items.map((a) => this.toDto(a)), meta: buildMeta(total, params) };
  }

  async getBySlug(slug: string): Promise<ArticleDto> {
    const article = await this.prisma.educationArticle.findUnique({ where: { slug } });
    if (!article) throw BusinessException.notFound('Article not found');
    await this.prisma.educationArticle.update({
      where: { id: article.id },
      data: { views: { increment: 1 } },
    });
    return this.toDto(article);
  }

  async create(input: {
    topic: string;
    title: string;
    slug?: string;
    content: string;
    summary?: string;
    videoUrl?: string;
    coverImageKey?: string;
    sortOrder?: number;
    isPublished?: boolean;
    tags?: string[];
  }): Promise<ArticleDto> {
    const slug = input.slug ?? this.slugify(input.title);
    const article = await this.prisma.educationArticle.create({
      data: {
        publicId: randomUUID(),
        topic: input.topic as any,
        title: input.title,
        slug,
        content: input.content,
        summary: input.summary ?? null,
        videoUrl: input.videoUrl ?? null,
        coverUrl: input.coverImageKey ?? null,
        sortOrder: input.sortOrder ?? 0,
        isVisible: input.isPublished ?? true,
        tags: input.tags ?? [],
        views: 0,
      },
    });
    return this.toDto(article);
  }

  async update(id: bigint, input: Record<string, unknown>): Promise<ArticleDto> {
    const data: Record<string, unknown> = {};
    for (const k of ['topic', 'title', 'content', 'summary', 'videoUrl', 'coverImageKey', 'sortOrder', 'isPublished', 'tags']) {
      if (input[k] !== undefined) data[k] = input[k];
    }
    if (input.slug) data.slug = input.slug;
    if (input.title && !input.slug) data.slug = this.slugify(input.title as string);
    const article = await this.prisma.educationArticle.update({ where: { id }, data });
    return this.toDto(article);
  }

  async delete(id: bigint): Promise<void> {
    await this.prisma.educationArticle.delete({ where: { id } });
  }

  /** Mark an article as helpful (thumbs up). */
  async markHelpful(articleId: bigint): Promise<void> {
    await this.prisma.educationArticle.update({
      where: { id: articleId },
      data: { views: { increment: 1 } },
    });
  }

  /** Track that a user has read an article (for onboarding progress). */
  async trackProgress(userId: bigint, articleId: bigint): Promise<void> {
    await this.prisma.userEducationProgress.upsert({
      where: { userId_articleId: { userId, articleId } },
      update: { readAt: new Date() },
      create: { userId, articleId, readAt: new Date() },
    });
  }

  /** Get onboarding progress for a user. */
  async getProgress(userId: bigint): Promise<{
    totalArticles: number;
    readArticles: number;
    completed: boolean;
    unread: ArticleSummaryDto[];
  }> {
    const totalArticles = await this.prisma.educationArticle.count({
      where: { isVisible: true, topic: 'V2RAYN' },
    });
    const readCount = await this.prisma.userEducationProgress.count({
      where: { userId, article: { topic: 'V2RAYN' } },
    });
    const readArticleIds = await this.prisma.userEducationProgress.findMany({
      where: { userId, article: { topic: 'V2RAYN' } },
      select: { articleId: true },
    });
    const readIdSet = new Set(readArticleIds.map((r) => r.articleId));
    const unreadArticles = await this.prisma.educationArticle.findMany({
      where: { isVisible: true, topic: 'V2RAYN', id: { notIn: [...readIdSet] } },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      totalArticles,
      readArticles: readCount,
      completed: totalArticles > 0 && readCount >= totalArticles,
      unread: unreadArticles.map((a) => this.toSummaryDto(a)),
    };
  }

  private slugify(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200);
  }

  private toDto(a: any): ArticleDto {
    return {
      id: a.id.toString(),
      publicId: a.publicId,
      topic: a.topic,
      title: a.title,
      slug: a.slug,
      summary: a.summary,
      content: a.content,
      videoUrl: a.videoUrl,
      coverImageKey: a.coverUrl,
      sortOrder: a.sortOrder,
      isPublished: a.isVisible,
      tags: a.tags ?? [],
      readCount: a.views,
      helpfulCount: a.views,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  private toSummaryDto(a: any): ArticleSummaryDto {
    return {
      id: a.id.toString(),
      publicId: a.publicId,
      topic: a.topic,
      title: a.title,
      slug: a.slug,
      summary: a.summary,
      coverImageKey: a.coverUrl,
      sortOrder: a.sortOrder,
      readCount: a.views,
    };
  }
}
