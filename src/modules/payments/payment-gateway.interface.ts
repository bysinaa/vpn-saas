/**
 * Payment gateway abstraction layer.
 *
 * Each online payment provider implements IPaymentGateway and registers under
 * the PAYMENT_GATEWAYS token map keyed by gateway code. This keeps the core
 * PaymentsService free of provider-specific logic.
 */
export interface InitiateResult {
  paymentPublicId: string;
  gatewayTransactionId: string;
  redirectUrl?: string;
  directPay?: boolean; // true when the gateway verifies the payment inline
}

export interface VerifyResult {
  status: 'CONFIRMED' | 'PENDING' | 'FAILED';
  reference?: string;
  verificationCode?: number;
}

export interface IPaymentGateway {
  /** Stable unique code, e.g. 'zarinpal', 'nowpayments'. */
  readonly code: string;

  /**
   * Create a payment on the gateway side. Returns redirect URL (or inline
   * confirmation) plus the gateway's own transaction id.
   */
  initiate(params: {
    paymentId: bigint;
    amountToman: bigint;
    currency: string;
    description: string;
    callbackUrl: string;
    userPublicId: string;
  }): Promise<InitiateResult>;

  /**
   * Verify a payment after the user is redirected back / a webhook fires.
   */
  verify(params: { gatewayTransactionId: string; paymentId: bigint; amountToman: bigint }): Promise<VerifyResult>;
}

export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');
