import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Res,
  UsePipes,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
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
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly payments: PaymentsService) {}

  @Post('initiate')
  @UsePipes(new ZodValidationPipe(initiatePaymentSchema))
  initiate(@Body() body: InitiatePaymentInput, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.initiate({
      userId: user.id,
      orderPublicId: body.orderPublicId,
      method: body.method,
      cryptoCurrency: body.cryptoCurrency,
    });
  }

  @Post('receipts')
  @UsePipes(new ZodValidationPipe(submitReceiptSchema))
  submitReceipt(@Body() body: SubmitReceiptInput, @CurrentUser() user: AuthenticatedUser) {
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
  listMine(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.payments.listMine(user.id, query);
  }

  @Get(':publicId')
  findOne(@Param('publicId') publicId: string, @CurrentUser() user: AuthenticatedUser) {
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
  async onlineCallback(
    @Query('Authority') authority: string,
    @Query('Status') status: string,
    @Res() reply: FastifyReply,
  ) {
    try {
      const payment = await this.payments.handleOnlineCallback(authority, status);
      return this.sendCallbackPage(reply, payment.status === 'CONFIRMED');
    } catch {
      this.logger.warn('Online payment callback could not be completed');
      return this.sendCallbackPage(reply, false);
    }
  }

  private sendCallbackPage(reply: FastifyReply, success: boolean) {
    const title = success ? 'پرداخت موفقیت‌آمیز بود' : 'پرداخت تکمیل نشد';
    const message = success
      ? 'اشتراک شما در ربات فعال می‌شود. می‌توانید این صفحه را ببندید و به ربات برگردید.'
      : 'پرداخت تأیید نشد. لطفاً به ربات برگردید و وضعیت سفارش را بررسی کنید.';
    const color = success ? '#16a34a' : '#dc2626';
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#f8fafc;font-family:Tahoma,Arial,sans-serif;display:grid;place-items:center;min-height:100vh"><main style="max-width:520px;margin:24px;padding:32px;text-align:center;background:#fff;border-radius:18px;box-shadow:0 12px 40px #0f172a1a"><div style="font-size:52px">${success ? '✅' : '❌'}</div><h1 style="color:${color};font-size:24px">${title}</h1><p style="color:#475569;line-height:2">${message}</p></main></body></html>`,
      );
  }
}

@Controller('orders')
export class WalletOrderPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':publicId/pay-wallet')
  @HttpCode(200)
  payWithWallet(@Param('publicId') publicId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.payOrderWithWallet(publicId, user.id);
  }
}
