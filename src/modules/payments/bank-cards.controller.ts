import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UsePipes } from '@nestjs/common';
import { BankCardsService } from './bank-cards.service';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { createBankCardSchema, updateBankCardSchema } from './bank-cards.schemas';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@Controller('payments')
export class BankCardsAdminController {
  constructor(private readonly svc: BankCardsService) {}

  // Admin: list bank cards (paginated + search)
  @Get('admin/bank-cards')
  @RequirePermissions(['manage:bank_cards'])
  list(@Query() query: Record<string, unknown>) {
    return this.svc.listAll(query);
  }

  // Admin: get single card
  @Get('admin/bank-cards/:publicId')
  @RequirePermissions(['manage:bank_cards'])
  get(@Param('publicId') publicId: string) {
    return this.svc.findOne(publicId);
  }

  // Admin: create card
  @Post('admin/bank-cards')
  @RequirePermissions(['manage:bank_cards'])
  @UsePipes(new ZodValidationPipe(createBankCardSchema))
  create(@Body() body: any, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.create(
      {
        cardNumber: body.cardNumber,
        cardHolder: body.cardHolder,
        bankName: body.bankName,
        shebaNumber: body.shebaNumber,
        label: body.label,
        isActive: body.isActive,
        isDefault: body.isDefault,
        sortOrder: body.sortOrder,
      },
      user.id,
    );
  }

  // Admin: update card
  @Patch('admin/bank-cards/:publicId')
  @RequirePermissions(['manage:bank_cards'])
  @UsePipes(new ZodValidationPipe(updateBankCardSchema))
  update(
    @Param('publicId') publicId: string,
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.update(publicId, body, user.id);
  }

  // Admin: delete card
  @Delete('admin/bank-cards/:publicId')
  @RequirePermissions(['manage:bank_cards'])
  remove(@Param('publicId') publicId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.remove(publicId, user.id);
  }
}
