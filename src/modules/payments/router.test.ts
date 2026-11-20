import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createAccessToken } from '../auth/tokens.js';
import { SafepaySandboxGateway, type PaymentGateway } from '../../integrations/payments/provider.js';
import type { PaymentReceiptStorage } from './storage.js';
import { createPaymentRouter } from './router.js';

const secret = 'payment-test-access-secret-that-is-long-enough';
const playerId = '11111111-1111-4111-8111-111111111111';
const vendorId = '22222222-2222-4222-8222-222222222222';
const otherVendorId = '33333333-3333-4333-8333-333333333333';
const paymentId = '44444444-4444-4444-8444-444444444444';
const bookingId = '55555555-5555-4555-8555-555555555555';

function paymentRecord(options: { ownerId?: string; payerId?: string; method?: string; status?: string; provider?: string; isTournament?: boolean } = {}) {
  const tournament = {
    id: '66666666-6666-4666-8666-666666666666', organizerUserId: options.ownerId ?? vendorId,
    title: 'Lahore Weekend Cup', status: 'UPCOMING', startsAt: new Date(Date.now() + 86_400_000),
    venue: { id: 'venue-id', name: 'Arena', city: 'Lahore', vendorProfile: { ownerUserId: options.ownerId ?? vendorId } },
    organizer: { id: options.ownerId ?? vendorId, name: 'Venue Owner' },
  };
  return {
    id: paymentId, userId: options.payerId ?? playerId, provider: options.provider ?? 'SAFEPAY',
    method: options.method ?? 'ONLINE', environment: options.provider === 'DEVELOPMENT_MOCK' ? 'DEVELOPMENT' : 'SANDBOX',
    purpose: options.isTournament ? 'TOURNAMENT_ENTRY' : 'BOOKING_CONTRIBUTION',
    status: options.status ?? 'PENDING', amountPaisa: 10_000, currency: 'PKR', contributionId: null,
    bookingId: null, tournamentParticipantId: options.isTournament ? '77777777-7777-4777-8777-777777777777' : null, providerReference: null, checkoutUrl: null,
    idempotencyKey: null, metadata: null, settledAt: null, createdAt: new Date(), updatedAt: new Date(),
    user: { id: options.payerId ?? playerId, name: 'Player One' }, contribution: null,
    booking: options.isTournament ? null : {
      id: bookingId, venueId: 'venue-id', status: 'PENDING_PAYMENT', totalPaisa: 10_000,
      paymentStatus: 'PENDING', holdExpiresAt: new Date(Date.now() + 60_000),
      venue: { id: 'venue-id', name: 'Arena', vendorProfile: { ownerUserId: options.ownerId ?? vendorId } },
      court: { id: 'court-id', name: 'Court A' },
    },
    tournamentParticipant: options.isTournament ? {
      id: '77777777-7777-4777-8777-777777777777', userId: options.payerId ?? playerId,
      status: 'REGISTERED', paymentStatus: 'PENDING', totalEntryFeePaisa: 10_000,
      tournament,
    } : null,
    receipts: [], webhookEvents: [], audits: [],
  };
}

function setup(options: {
  role?: 'PLAYER' | 'VENDOR';
  payment?: ReturnType<typeof paymentRecord>;
  gateway?: PaymentGateway;
  storage?: PaymentReceiptStorage;
    tournamentParticipant?: unknown;
} = {}) {
  const role = options.role ?? 'PLAYER';
  const userId = role === 'PLAYER' ? playerId : vendorId;
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ id: userId, role, status: 'ACTIVE' })) },
    payment: {
      findUnique: vi.fn(async () => options.payment ?? paymentRecord()),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: paymentId, ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...(options.payment ?? paymentRecord()), ...data })),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    $queryRaw: vi.fn(async () => []),
    paymentStatusAudit: { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 0 })) },
    paymentContribution: { update: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    tournamentParticipant: {
      findUnique: vi.fn(async () => options.tournamentParticipant ?? null),
      update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })),
    },
    bookingParticipant: { update: vi.fn(), updateMany: vi.fn() },
    booking: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    webhookEvent: { create: vi.fn(async () => ({})) },
    vendorProfile: { findUnique: vi.fn(async () => ({ id: 'vendor-profile-id' })) },
    vendorPaymentInstructions: { upsert: vi.fn(), findFirst: vi.fn() },
  } as unknown as PrismaClient & Record<string, unknown>;
  const storage = options.storage ?? {
    createSignedUpload: vi.fn(), getObjectInfo: vi.fn(), createSignedDownload: vi.fn(), deleteObject: vi.fn(),
  } satisfies PaymentReceiptStorage;
  const gateway = options.gateway ?? new SafepaySandboxGateway({ environment: 'sandbox' });
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createPaymentRouter({ prisma, accessSecret: secret, gateway, storage, nodeEnv: 'test' }));
  app.use(errorHandler);
  const token = createAccessToken(userId, role, secret);
  return { app, token, prisma, storage, gateway };
}

describe('payment route safety', () => {
  it('creates a server-priced tournament team entry payment for its registered leader', async () => {
    const participant = {
      id: '77777777-7777-4777-8777-777777777777', userId: playerId, status: 'REGISTERED',
      paymentStatus: 'UNPAID', totalEntryFeePaisa: 10_000,
      tournament: { id: '66666666-6666-4666-8666-666666666666', status: 'UPCOMING', startsAt: new Date(Date.now() + 86_400_000) },
    };
    const { app, token, prisma } = setup({ tournamentParticipant: participant, payment: paymentRecord({ isTournament: true }) });
    const response = await request(app).post(`/api/v1/tournaments/${participant.tournament.id}/teams/me/payments`)
      .set('Authorization', `Bearer ${token}`).send({ method: 'ONLINE' });

    expect(response.status).toBe(201);
    expect(response.body.data.payment).toMatchObject({ purpose: 'TOURNAMENT_ENTRY', amountPaisa: 10_000 });
    expect((prisma.payment as unknown as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tournamentParticipantId: participant.id, provider: 'SAFEPAY', method: 'ONLINE' }),
    }));
    expect((prisma.tournamentParticipant as unknown as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: participant.id }, data: { paymentStatus: 'PENDING' },
    }));
  });

  it('creates checkout for a tournament entry only while the registered tournament is payable', async () => {
    const gateway = {
      provider: 'DEVELOPMENT_MOCK', environment: 'DEVELOPMENT',
      createCheckout: vi.fn(async () => ({ providerReference: 'mock-ref', checkoutUrl: 'https://checkout.example.test/pay', simulation: false })),
      verifyWebhook: vi.fn(() => false),
    } satisfies PaymentGateway;
    const payment = paymentRecord({ isTournament: true, provider: 'DEVELOPMENT_MOCK', status: 'PENDING' });
    const { app, token } = setup({ payment, gateway });
    const response = await request(app).post(`/api/v1/payments/${paymentId}/checkout`)
      .set('Authorization', `Bearer ${token}`).send({});

    expect(response.status).toBe(200);
    expect(response.body.data.checkoutUrl).toBe('https://checkout.example.test/pay');
    expect(gateway.createCheckout).toHaveBeenCalledWith({ paymentId, amountPaisa: payment.amountPaisa });
  });

  it('marks the registered team paid only when a tournament payment is verified', async () => {
    const gateway = {
      provider: 'DEVELOPMENT_MOCK', environment: 'DEVELOPMENT',
      createCheckout: vi.fn(), verifyWebhook: vi.fn(() => false),
    } satisfies PaymentGateway;
    const payment = paymentRecord({ isTournament: true, provider: 'DEVELOPMENT_MOCK', status: 'PENDING' });
    const { app, token, prisma } = setup({ payment, gateway });
    const response = await request(app).post(`/api/v1/payments/${paymentId}/simulate`)
      .set('Authorization', `Bearer ${token}`).send({ result: 'succeeded' });

    expect(response.status).toBe(200);
    expect((prisma.tournamentParticipant as unknown as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: payment.tournamentParticipantId }, data: { paymentStatus: 'PAID' },
    }));
  });

  it('returns a configuration error instead of a fake hosted checkout when Safepay keys are missing', async () => {
    const { app, token, prisma } = setup();
    const response = await request(app).post(`/api/v1/payments/${paymentId}/checkout`)
      .set('Authorization', `Bearer ${token}`).send({});

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SAFEPAY_NOT_CONFIGURED');
    expect(response.body).not.toHaveProperty('checkoutUrl');
    expect((prisma.payment as unknown as { updateMany: ReturnType<typeof vi.fn> }).updateMany).toHaveBeenCalledTimes(2);
  });

  it('does not persist or process a webhook with an invalid signature', async () => {
    const gateway = {
      provider: 'SAFEPAY', environment: 'SANDBOX',
      createCheckout: vi.fn(), verifyWebhook: vi.fn(() => false),
    } satisfies PaymentGateway;
    const { app, prisma } = setup({ gateway });
    const response = await request(app).post('/api/v1/webhooks/safepay')
      .set('x-sfpy-signature', 'not-a-signature').send({ data: { notification: { state: 'PAID' } } });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    expect((prisma.webhookEvent as unknown as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('does not let a different vendor mark another venue cash payment collected', async () => {
    const { app, token, prisma } = setup({
      role: 'VENDOR', payment: paymentRecord({ ownerId: otherVendorId, method: 'PAY_AT_VENUE', status: 'DUE_AT_VENUE', provider: 'MANUAL' }),
    });
    const response = await request(app).post(`/api/v1/vendors/me/payments/${paymentId}/mark-cash-received`)
      .set('Authorization', `Bearer ${token}`).send({ amountPaisa: 10_000 });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PAYMENT_NOT_FOUND');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects cash collection when the vendor amount does not match the server-calculated amount', async () => {
    const { app, token, prisma } = setup({
      role: 'VENDOR', payment: paymentRecord({ ownerId: vendorId, method: 'PAY_AT_VENUE', status: 'DUE_AT_VENUE', provider: 'MANUAL' }),
    });
    const response = await request(app).post(`/api/v1/vendors/me/payments/${paymentId}/mark-cash-received`)
      .set('Authorization', `Bearer ${token}`).send({ amountPaisa: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not create a signed receipt upload URL for a non-payer', async () => {
    const storage = {
      createSignedUpload: vi.fn(), getObjectInfo: vi.fn(), createSignedDownload: vi.fn(), deleteObject: vi.fn(),
    } satisfies PaymentReceiptStorage;
    const { app, token } = setup({
      payment: paymentRecord({ payerId: otherVendorId, method: 'BANK_TRANSFER', status: 'AWAITING_TRANSFER', provider: 'MANUAL' }),
      storage,
    });
    const response = await request(app).post(`/api/v1/payments/${paymentId}/receipt/signed-upload`)
      .set('Authorization', `Bearer ${token}`).send({ fileName: 'receipt.pdf', mimeType: 'application/pdf', sizeBytes: 1024 });

    expect(response.status).toBe(404);
    expect(storage.createSignedUpload).not.toHaveBeenCalled();
  });
});
