import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@ApiTags('Subscriptions')
@ApiBearerAuth()
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  @ApiOperation({ summary: 'List my subscriptions' })
  mine(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.subs.listMine(user.id, query);
  }

  @Get(':publicId')
  @ApiOperation({ summary: 'Get a subscription' })
  one(@CurrentUser() user: AuthenticatedUser, @Param('publicId') publicId: string) {
    return this.subs.getById(BigInt(publicId));
  }

  @Post(':publicId/renew')
  @ApiOperation({ summary: 'Renew subscription' })
  renew(@CurrentUser() user: AuthenticatedUser, @Param('publicId') publicId: string) {
    return this.subs.renew(publicId, user.id);
  }

  @Post(':publicId/suspend')
  @ApiOperation({ summary: 'Suspend subscription' })
  suspend(@CurrentUser() user: AuthenticatedUser, @Param('publicId') publicId: string) {
    return this.subs.suspend(publicId, user.id);
  }

  @Post(':publicId/resume')
  @ApiOperation({ summary: 'Resume subscription' })
  resume(@CurrentUser() user: AuthenticatedUser, @Param('publicId') publicId: string) {
    return this.subs.resume(publicId, user.id);
  }

  @Post(':publicId/pause')
  @ApiOperation({ summary: 'Pause subscription (if plan allows)' })
  pause(@CurrentUser() user: AuthenticatedUser, @Param('publicId') publicId: string) {
    return this.subs.pause(publicId, user.id);
  }

  @Post(':publicId/reset-traffic')
  @ApiOperation({ summary: 'Reset traffic counter' })
  reset(@CurrentUser() user: AuthenticatedUser, @Param('publicId') publicId: string) {
    return this.subs.resetTraffic(publicId, user.id);
  }

  @Post(':publicId/extend')
  @ApiOperation({ summary: 'Extend subscription by N days' })
  extend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('publicId') publicId: string,
    @Body() body: { days: number },
  ) {
    return this.subs.extend(publicId, user.id, body.days);
  }

  @Post(':publicId/transfer')
  @ApiOperation({ summary: 'Transfer subscription to another user' })
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('publicId') publicId: string,
    @Body() body: { toUserId: string },
  ) {
    return this.subs.transfer(publicId, user.id, BigInt(body.toUserId));
  }

  // ---- Admin ----
  @Get('admin/all')
  @RequirePermissions(['read:subscriptions'])
  @ApiOperation({ summary: 'List all subscriptions (admin)' })
  all(@Query() query: Record<string, unknown>) {
    return this.subs.listAll(query);
  }
}
