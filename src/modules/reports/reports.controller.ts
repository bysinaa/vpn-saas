import { Body, Controller, Post, UsePipes } from '@nestjs/common';
import { ReportsService } from './reports.service';
import {
  RevenueReportInput,
  SubscriptionsReportInput,
  UsersReportInput,
  revenueReportSchema,
  subscriptionsReportSchema,
  usersReportSchema,
} from './reports.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

/**
 * ReportsController - generates downloadable CSV reports.
 * All endpoints require admin permissions.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post('revenue')
  @RequirePermissions(['read:reports'])
  @UsePipes(new ZodValidationPipe(revenueReportSchema))
  revenue(@Body() body: RevenueReportInput) {
    return this.reports.revenueReport(
      new Date(body.from),
      new Date(body.to),
      body.groupBy,
    );
  }

  @Post('subscriptions')
  @RequirePermissions(['read:reports'])
  @UsePipes(new ZodValidationPipe(subscriptionsReportSchema))
  subscriptions(@Body() body: SubscriptionsReportInput) {
    return this.reports.subscriptionsReport(
      body.from ? new Date(body.from) : undefined,
      body.to ? new Date(body.to) : undefined,
      body.status,
    );
  }

  @Post('users')
  @RequirePermissions(['read:reports'])
  @UsePipes(new ZodValidationPipe(usersReportSchema))
  users(@Body() body: UsersReportInput) {
    return this.reports.usersReport(
      body.from ? new Date(body.from) : undefined,
      body.to ? new Date(body.to) : undefined,
      body.status,
    );
  }
}
