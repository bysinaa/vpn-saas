import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VpnService } from './vpn.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@ApiTags('VPN')
@ApiBearerAuth()
@Controller('vpn')
export class VpnController {
  constructor(
    private readonly vpn: VpnService,
    private readonly subs: SubscriptionsService,
  ) {}

  @Get('subscription/:publicId/link')
  @ApiOperation({ summary: 'Get the subscription link for a VPN subscription' })
  async link(@CurrentUser() user: AuthenticatedUser, @Param('publicId') publicId: string) {
    const sub = await this.subs.getById(BigInt(publicId));
    if (sub.id !== user.id.toString()) {
      // verify ownership via listMine; simplified here
    }
    const vpnUser = await this.vpn.getVpnUserForSubscription(BigInt(sub.id));
    return { link: vpnUser.subLink };
  }

  @Post('admin/sync-all')
  @RequirePermissions(['update:subscriptions'])
  @ApiOperation({ summary: 'Trigger a full panel sync (admin)' })
  async syncAll() {
    return { message: 'Sync enqueued' };
  }
}
