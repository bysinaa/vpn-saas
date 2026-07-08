import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderInput, createOrderSchema } from './orders.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(createOrderSchema))
  async create(
    @Body() body: CreateOrderInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.create({
      userId: user.id,
      planPublicId: body.planPublicId,
      type: body.type,
      quantity: body.quantity,
      giftForUserId: body.giftForUserPublicId ? BigInt(body.giftForUserPublicId) : undefined,
      paymentMethod: body.paymentMethod,
    });
  }

  @Post(':publicId/pay-wallet')
  @HttpCode(200)
  async payWithWallet(
    @Param('publicId') publicId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.payWithWallet(publicId, user.id);
  }

  @Delete(':publicId')
  async cancel(
    @Param('publicId') publicId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.cancel(publicId, user.id);
  }

  @Get('mine')
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ) {
    return this.orders.listMine(user.id, query);
  }

  @Get(':publicId')
  findOne(
    @Param('publicId') publicId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.findOne(publicId, user.id);
  }

  @Get('admin/all')
  @RequirePermissions(['read:orders'])
  listAll(@Query() query: Record<string, unknown>) {
    return this.orders.listAll(query);
  }
}
