import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @ApiOperation({ summary: 'Get my wallet balance' })
  balance(@CurrentUser() user: AuthenticatedUser) {
    return this.wallet.getBalance(user.id);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'List my wallet transactions' })
  transactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ) {
    return this.wallet.listTransactions(user.id, query);
  }

  @Get('admin/:userId')
  @RequirePermissions(['read:wallets'])
  @ApiOperation({ summary: 'Admin: view any user wallet' })
  adminBalance(@Query('userId') userId: string) {
    return this.wallet.getBalance(BigInt(userId));
  }
}
