import { z } from 'zod';

export const initiatePaymentSchema = z.object({
  orderPublicId: z.string().uuid('Invalid order id'),
  method: z.enum(['ONLINE', 'CARD_TO_CARD', 'CRYPTO', 'VOUCHER']),
  // For card-to-card: receipt upload happens separately
  // For crypto: chosen currency
  cryptoCurrency: z.enum(['USDT_TRC20', 'USDT_ERC20', 'TON', 'BTC', 'ETH']).optional(),
  // For voucher: voucher code
  voucherCode: z.string().min(4).max(64).optional(),
});

export type InitiatePaymentInput = z.infer<typeof initiatePaymentSchema>;

export const submitReceiptSchema = z.object({
  paymentPublicId: z.string().uuid('Invalid payment id'),
  payerName: z.string().min(2).max(100),
  cardNumber: z.string().min(4).max(32).optional(),
  amount: z.number().int().positive().optional(),
  // receipt file from S3 (uploaded via storage endpoint)
  fileUrl: z.string().url().min(4).max(512),
  fileKey: z.string().min(4).max(256),
  mimeType: z.string().min(3).max(100),
  fileSize: z.number().int().positive(),
});

export type SubmitReceiptInput = z.infer<typeof submitReceiptSchema>;

export const verifyReceiptSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  adminNote: z.string().max(500).optional(),
});

export type VerifyReceiptInput = z.infer<typeof verifyReceiptSchema>;

export const verifyCryptoPaymentSchema = z.object({
  txHash: z.string().min(8).max(128),
});

export type VerifyCryptoPaymentInput = z.infer<typeof verifyCryptoPaymentSchema>;

export const redeemVoucherSchema = z.object({
  code: z.string().min(4).max(64),
});

export type RedeemVoucherInput = z.infer<typeof redeemVoucherSchema>;
