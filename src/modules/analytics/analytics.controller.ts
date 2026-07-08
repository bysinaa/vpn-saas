import { Controller, Get, Post, Query, UsePipes } from '@nestjs/common';
import { z } from 'zod';
import { AnalyticsService } from './analytics.service';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

const seriesQuerySchema = z.object({
  metric: z.string().min(1),
  from: z.string().datetime(),
  to: z.string().datetime(),
});

type SeriesQuery = z.infer<typeof seriesQuerySchema>;

/**
 * AnalyticsController - exposes aggregated platform metrics.
 * All endpoints require admin/analyst permissions.
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('metrics')
  @RequirePermissions(['read:analytics'])
  listMetrics() {
    return { metrics: this.analytics.listMetrics() };
  }

  @Get('series')
  @RequirePermissions(['read:analytics'])
  @UsePipes(new ZodValidationPipe(seriesQuerySchema))
  getSeries(@Query() query: SeriesQuery) {
    return this.analytics.getSeries(
      query.metric,
      new Date(query.from),
      new Date(query.to),
    );
  }

  @Get('summary')
  @RequirePermissions(['read:analytics'])
  getSummary(@Query('metric') metric: string) {
    return this.analytics.getSummary(metric);
  }

  /**
   * Manually trigger a daily snapshot (for backfill or re-run).
   */
  @Post('snapshot')
  @RequirePermissions(['manage:analytics'])
  runSnapshot(@Query('date') date?: string) {
    return this.analytics.snapshotDaily(date ? new Date(date) : undefined);
  }
}
