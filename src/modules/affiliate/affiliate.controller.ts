import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import {
  UpdateAffiliateInput,
  updateAffiliateSchema,
  PayoutCommissionInput,
  payoutCommissionSchema,
} from './affiliate.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@Controller('affiliate')
export class AffiliateController {
  constructor(private readonly affiliate: AffiliateService) {}

  @Post('apply')
  apply(@CurrentUser() user: AuthenticatedUser) {
    return this.affiliate.apply(user.id);
  }

  @Get('me')
  getMyAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.affiliate.getMyAccount(user.id);
  }

  @Get('me/commissions')
  listMyCommissions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ) {
    return this.affiliate.listCommissions(user.id, query);
  }

  @Post('me/payout')
  @UsePipes(new ZodValidationPipe(payoutCommissionSchema))
  payout(
    @Body() body: PayoutCommissionInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.affiliate.payout(
      user.id,
      body.commissionIds.map((id: string) => BigInt(id)),
    );
  }

  // ---- Admin ----
  @Get('admin/accounts')
  @RequirePermissions(['read:affiliates'])
  listAccounts(@Query() query: Record<string, unknown>) {
    return this.affiliate.listAccounts(query);
  }

  @Get('admin/referrals')
  @RequirePermissions(['read:affiliates'])
  listReferrals(@Query() query: Record<string, unknown>) {
    return this.affiliate.listReferrals(query);
  }

  @Patch('admin/accounts/:id')
  @RequirePermissions(['manage:affiliates'])
  @UsePipes(new ZodValidationPipe(updateAffiliateSchema))
  updateAccount(
    @Param('id') id: string,
    @Body() body: UpdateAffiliateInput,
  ) {
    return this.affiliate.updateAccount(BigInt(id), body);
  }
}
