import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import {
  InitiatePaymentInput,
  initiatePaymentSchema,
  SubmitReceiptInput,
  submitReceiptSchema,
  VerifyReceiptInput,
  verifyReceiptSchema,
} from './payments.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('initiate')
  @UsePipes(new ZodValidationPipe(initiatePaymentSchema))
  initiate(
    @Body() body: InitiatePaymentInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.initiate({
      userId: user.id,
      orderPublicId: body.orderPublicId,
      method: body.method,
      cryptoCurrency: body.cryptoCurrency,
      voucherCode: body.voucherCode,
    });
  }

  @Post('receipts')
  @UsePipes(new ZodValidationPipe(submitReceiptSchema))
  submitReceipt(
    @Body() body: SubmitReceiptInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.submitReceipt({
      userId: user.id,
      paymentPublicId: body.paymentPublicId,
      payerName: body.payerName,
      cardNumber: body.cardNumber,
      amount: body.amount ? BigInt(body.amount) : undefined,
      fileUrl: body.fileUrl,
      fileKey: body.fileKey,
      mimeType: body.mimeType,
      fileSize: body.fileSize,
    });
  }

  @Get('mine')
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ) {
    return this.payments.listMine(user.id, query);
  }

  @Get(':publicId')
  findOne(
    @Param('publicId') publicId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.findOne(publicId, user.id);
  }

  // ---- Admin ----
  @Get('admin/receipts')
  listReceiptsPending(@Query() query: Record<string, unknown>) {
    return this.payments.listReceiptsPending(query);
  }

  @Post('admin/receipts/:receiptPublicId/verify')
  @RequirePermissions(['verify:payments'])
  @UsePipes(new ZodValidationPipe(verifyReceiptSchema))
  verifyReceipt(
    @Param('receiptPublicId') receiptPublicId: string,
    @Body() body: VerifyReceiptInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.verifyReceipt({
      adminId: user.id,
      receiptPublicId,
      status: body.status,
      adminNote: body.adminNote,
    });
  }

  // ---- Public gateway callback (no auth; verified via signature) ----
  @Public()
  @Get('online/callback')
  onlineCallback(
    @Query('Authority') authority: string,
    @Query('Status') status: string,
  ) {
    if (status !== 'OK') {
      return { success: false, message: 'Payment cancelled' };
    }
    return this.payments.verifyOnlinePayment(authority, 'zarinpal');
  }
}
