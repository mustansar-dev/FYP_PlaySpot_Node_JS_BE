import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPaymentGateway, DevelopmentMockPaymentGateway, SafepaySandboxGateway } from './provider.js';

describe('payment provider adapters', () => {
  it('does not fabricate a Safepay checkout when credentials or return URLs are missing', async () => {
    const provider = new SafepaySandboxGateway({ environment: 'sandbox' });
    await expect(provider.createCheckout({ paymentId: 'payment-id', amountPaisa: 1000 })).rejects.toMatchObject({
      statusCode: 503, code: 'SAFEPAY_NOT_CONFIGURED',
    });
  });

  it('verifies the standard Safepay SDK webhook signature and rejects changed payloads', () => {
    const secret = 'sandbox-webhook-secret';
    const body = { data: { notification: { tracker: 'track_example', state: 'PAID', amount: '100.00', currency: 'PKR' } } };
    const signature = createHmac('sha512', secret).update(JSON.stringify(body.data)).digest('hex');
    const provider = new SafepaySandboxGateway({ environment: 'sandbox', webhookSecret: secret });

    expect(provider.verifyWebhook(body, signature)).toBe(true);
    expect(provider.verifyWebhook({ ...body, data: { ...body.data, notification: { ...body.data.notification, amount: '200.00' } } }, signature)).toBe(false);
    expect(provider.verifyWebhook(body, `sha256=${signature}`)).toBe(false);
  });

  it('creates no hosted URL from the development mock and blocks it in production', async () => {
    const mock = new DevelopmentMockPaymentGateway();
    await expect(mock.createCheckout({ paymentId: 'payment-id', amountPaisa: 1000 })).resolves.toMatchObject({
      providerReference: 'mock_payment-id', checkoutUrl: null, simulation: true,
    });
    expect(() => createPaymentGateway({
      paymentProvider: 'development_mock', nodeEnv: 'production', safepay: { environment: 'sandbox' },
    })).toThrow(/cannot run in production/);
  });
});
