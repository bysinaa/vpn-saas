import { Controller, Get, Query } from '@nestjs/common';
import { AdminService } from './admin.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('dashboard')
  @RequirePermissions(['read:dashboard'])
  dashboard() {
    return this.admin.getDashboardStats();
  }

  @Get('revenue-series')
  @RequirePermissions(['read:dashboard'])
  revenueSeries(@Query('days') days?: string) {
    return this.admin.getRevenueSeries(days ? Number(days) : 30);
  }

  @Get('user-growth')
  @RequirePermissions(['read:dashboard'])
  userGrowth(@Query('days') days?: string) {
    return this.admin.getUserGrowthSeries(days ? Number(days) : 30);
  }
}
