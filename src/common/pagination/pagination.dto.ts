import { ApiProperty } from '@nestjs/swagger';

/**
 * Standard paginated response envelope used across all list endpoints.
 * Keeps API contracts consistent for bot, mini-app, web & mobile clients.
 */
export class PaginationMetaDto {
  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;

  @ApiProperty()
  hasNext!: boolean;

  @ApiProperty()
  hasPrev!: boolean;
}

export class PaginatedDto<T> {
  @ApiProperty({ type: 'array' })
  data!: T[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function parsePagination(query: Record<string, unknown>): PaginationParams {
  const page = clampInt(query.page, 1, 1, 1_000_000);
  const pageSize = clampInt(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const sortBy = typeof query.sortBy === 'string' ? query.sortBy : undefined;
  const sortOrder = query.sortOrder === 'desc' ? 'desc' : 'asc';
  const search = typeof query.search === 'string' ? query.search.trim() : undefined;
  return { page, pageSize, sortBy, sortOrder, search };
}

export function paginate<T>(items: T[], total: number, params: PaginationParams): PaginatedDto<T> {
  const totalPages = total === 0 ? 1 : Math.ceil(total / params.pageSize);
  return {
    data: items,
    meta: {
      page: params.page,
      pageSize: params.pageSize,
      total,
      totalPages,
      hasNext: params.page < totalPages,
      hasPrev: params.page > 1,
    },
  };
}

export function skipTake(params: PaginationParams): { skip: number; take: number } {
  return { skip: (params.page - 1) * params.pageSize, take: params.pageSize };
}

export function buildMeta(total: number, params: PaginationParams): PaginationMetaDto {
  const totalPages = total === 0 ? 1 : Math.ceil(total / params.pageSize);
  return {
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages,
    hasNext: params.page < totalPages,
    hasPrev: params.page > 1,
  };
}

function clampInt(val: unknown, def: number, min: number, max: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
