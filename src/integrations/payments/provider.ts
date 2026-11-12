import { createHmac, timingSafeEqual } from 'node:crypto';
import { Safepay } from '@sfpy/node-sdk';
import { HttpError } from '../../common/httpError.js';

export interface CheckoutRequest {
  paymentId: string;
  amountPaisa: number;
  returnUrl?: string;
  cancelUrl?: string;
}

export interface CheckoutResult {
  providerReference: string;
  checkoutUrl: string | null;
  simulation: boolean;
}

export interface PaymentGateway {
  readonly provider: 'SAFEPAY' | 'DEVELOPMENT_MOCK';
  readonly environment: 'SANDBOX' | 'DEVELOPMENT';
  createCheckout(input: CheckoutRequest): Promise<CheckoutResult>;
  verifyWebhook(body: unknown, signature: string | undefined): boolean;
}

export interface SafepayConfig {
  environment: 'sandbox';
  apiKey?: string;
  secretKey?: string;
  webhookSecret?: string;
  returnUrl?: string;
  cancelUrl?: string;
}

export class SafepaySandboxGateway implements PaymentGateway {
  readonly provider = 'SAFEPAY' as const;
  readonly environment = 'SANDBOX' as const;

  constructor(private readonly config: SafepayConfig) {}

  async createCheckout(input: CheckoutRequest): Promise<CheckoutResult> {
    const { apiKey, secretKey, webhookSecret } = this.config;
    const returnUrl = input.returnUrl ?? this.config.returnUrl;
    const cancelUrl = input.cancelUrl ?? this.config.cancelUrl;
    if (!apiKey || !secretKey || !webhookSecret || !returnUrl || !cancelUrl) {
      throw new HttpError(503, 'SAFEPAY_NOT_CONFIGURED', 'Safepay Sandbox credentials and return/cancel URLs are not configured.');
    }
    if (!Number.isSafeInteger(input.amountPaisa) || input.amountPaisa <= 0) {
      throw new HttpError(400, 'INVALID_PAYMENT_AMOUNT', 'The payment amount must be a positive integer number of paisa.');
    }

    try {
      const client = new Safepay({ environment: 'sandbox' as ConstructorParameters<typeof Safepay>[0]['environment'], apiKey, v1Secret: secretKey, webhookSecret });
      const tracker = await client.payments.create({ amount: input.amountPaisa, currency: 'PKR' });
      if (!tracker.token) throw new Error('Safepay did not return a tracker token.');
      const checkoutUrl = client.checkout.create({
        token: tracker.token,
        orderId: input.paymentId,
        cancelUrl,
        redirectUrl: returnUrl,
        source: 'custom',
        webhooks: true,
      });
      return { providerReference: tracker.token, checkoutUrl, simulation: false };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'SAFEPAY_UNAVAILABLE', 'Safepay Sandbox could not create a checkout session.');
    }
  }

  verifyWebhook(body: unknown, signature: string | undefined): boolean {
    if (!this.config.webhookSecret || !signature || typeof body !== 'object' || body === null || !('data' in body)) return false;
    let serialized: string;
    try { serialized = JSON.stringify((body as { data: unknown }).data); } catch { return false; }
    if (typeof serialized !== 'string') return false;
    const expected = createHmac('sha512', this.config.webhookSecret).update(serialized).digest();
    const providedText = signature.trim().toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(providedText)) return false;
    const provided = Buffer.from(providedText, 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
}

/** Local test/demo adapter. It never creates a hosted checkout or represents a real payment. */
export class DevelopmentMockPaymentGateway implements PaymentGateway {
  readonly provider = 'DEVELOPMENT_MOCK' as const;
  readonly environment = 'DEVELOPMENT' as const;

  async createCheckout(input: CheckoutRequest): Promise<CheckoutResult> {
    return { providerReference: `mock_${input.paymentId}`, checkoutUrl: null, simulation: true };
  }

  verifyWebhook(): boolean {
    return false;
  }
}

export function createPaymentGateway(config: {
  paymentProvider: 'safepay' | 'development_mock';
  nodeEnv: 'development' | 'test' | 'production';
  safepay: SafepayConfig;
}): PaymentGateway {
  if (config.paymentProvider === 'development_mock') {
    if (config.nodeEnv === 'production') {
      throw new Error('The development payment mock cannot run in production.');
    }
    return new DevelopmentMockPaymentGateway();
  }
  return new SafepaySandboxGateway(config.safepay);
}
