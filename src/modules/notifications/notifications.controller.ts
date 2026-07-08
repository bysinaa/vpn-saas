import { Controller, Get, Post, Body, UseGuards, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { BroadcastService } from './broadcast.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthorizationGuard } from '../auth/guards/authorization.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { BroadcastSchemas } from './notifications.schemas';

@Controller('admin/notifications')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
@Roles('SUPER_ADMIN', 'ADMIN', 'OPERATOR')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly broadcast: BroadcastService,
  ) {}

  @Post('broadcast')
  async createBroadcast(@Body() body: { message: string; targetRole?: string }) {
    const input = BroadcastSchemas.create.parse(body);
    return this.notifications.createBroadcast({
      message: input.message,
      targetRole: input.targetRole,
    });
  }

  @Get('broadcasts')
  async listBroadcasts(@Query('limit') limit?: string) {
    return this.notifications.listBroadcasts(limit ? parseInt(limit, 10) : 20);
  }

  @Get('broadcasts/:id')
  async getBroadcastStats(@Query('id') id: string) {
    return this.notifications.getBroadcastStats(id);
  }
}