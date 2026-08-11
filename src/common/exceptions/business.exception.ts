import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain-level business errors carry a stable error code for clients.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TOO_MANY_REQUESTS'
  | 'PAYMENT_REQUIRED'
  | 'WALLET_INSUFFICIENT_FUNDS'
  | 'TRIAL_ALREADY_USED'
  | 'SUBSCRIPTION_EXPIRED'
  | 'SERVER_MAINTENANCE'
  | 'PANEL_API_ERROR'
  | 'PAYMENT_REJECTED'
  | 'RECEIPT_REJECTED'
  | 'VOUCHER_INVALID'
  | 'VOUCHER_EXPIRED'
  | 'REFERRAL_INVALID'
  | 'DUPLICATE_ENTITY'
  | 'INTERNAL_ERROR';

export class BusinessException extends HttpException {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    details?: unknown,
  ) {
    super({ code, message, details }, status);
    this.code = code;
    this.details = details;
  }

  static notFound(message: string, details?: unknown) {
    return new BusinessException('NOT_FOUND', message, HttpStatus.NOT_FOUND, details);
  }
  static conflict(message: string, details?: unknown) {
    return new BusinessException('CONFLICT', message, HttpStatus.CONFLICT, details);
  }
  static unauthorized(message = 'Unauthorized') {
    return new BusinessException('UNAUTHORIZED', message, HttpStatus.UNAUTHORIZED);
  }
  static forbidden(message = 'Forbidden') {
    return new BusinessException('FORBIDDEN', message, HttpStatus.FORBIDDEN);
  }
  static paymentRequired(message = 'Payment required') {
    return new BusinessException('PAYMENT_REQUIRED', message, HttpStatus.PAYMENT_REQUIRED);
  }
}
