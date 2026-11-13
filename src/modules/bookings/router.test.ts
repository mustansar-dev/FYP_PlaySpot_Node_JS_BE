import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createAccessToken } from '../auth/tokens.js';
import { createBookingRouter } from './router.js';

const secret = 'booking-test-access-secret-that-is-long-enough';
const playerId = '11111111-1111-4111-8111-111111111111';
const otherPlayerId = '22222222-2222-4222-8222-222222222222';
const vendorId = '33333333-3333-4333-8333-333333333333';
const courtId = '44444444-4444-4444-8444-444444444444';
const venueId = '55555555-5555-4555-8555-555555555555';
const equipmentId = '66666666-6666-4666-8666-666666666666';
const bookingId = '77777777-7777-4777-8777-777777777777';

function futureDateKey(): string {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  return date.toISOString().slice(0, 10);
}

type FakeParticipantData = Record<string, unknown> & {
  userId: string;
  contribution?: { create: Record<string, unknown> };
};
type FakeBookingData = Record<string, unknown> & {
  items?: { create?: Array<Record<string, unknown>> };
  participants?: { create?: FakeParticipantData[] };
};

function setup(options: { role?: 'PLAYER' | 'VENDOR'; ownsCourt?: boolean; conflict?: boolean } = {}) {
  const role = options.role ?? 'PLAYER';
  const userId = role === 'PLAYER' ? playerId : vendorId;
  const users = [
    { id: playerId, name: 'Player One' },
    { id: otherPlayerId, name: 'Player Two' },
  ];
  const court = {
    id: courtId, venueId, name: 'Court A', openingTime: '09:00', closingTime: '17:00',
    availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    slotDurationMinutes: 60, hourlyPricePaisa: 40_000,
    venue: { timeZone: 'Asia/Karachi' },
  };
  const prisma: Record<string, unknown> = {};
  const createdBooking = vi.fn(async ({ data }: { data: FakeBookingData }) => {
    const items = (data.items?.create ?? []).map((item: Record<string, unknown>, index: number) => ({
      id: `item-${index}`, bookingId, ...item,
    }));
    const participants = (data.participants?.create ?? []).map((participant, index) => ({
      id: `participant-${index}`, bookingId, ...participant,
      user: users.find(user => user.id === participant.userId)!,
      contribution: participant.contribution ? {
        id: `contribution-${index}`, bookingParticipantId: `participant-${index}`,
        ...participant.contribution.create,
      } : null,
    }));
    return {
      id: bookingId, venueId, courtId, customerUserId: data.customerUserId ?? null,
      createdByUserId: data.createdByUserId ?? null, tournamentId: null, source: data.source,
      status: data.status, paymentMode: data.paymentMode, paymentStatus: data.paymentStatus,
      startsAt: data.startsAt, endsAt: data.endsAt, timeZone: data.timeZone,
      customerName: data.customerName ?? null, customerPhone: data.customerPhone ?? null,
      groundFeePaisa: data.groundFeePaisa, addOnsTotalPaisa: data.addOnsTotalPaisa, totalPaisa: data.totalPaisa,
      currency: data.currency, idempotencyKey: data.idempotencyKey, holdExpiresAt: data.holdExpiresAt,
      cancelledAt: null, createdAt: new Date('2026-11-12T10:00:00Z'), updatedAt: new Date('2026-11-12T10:00:00Z'),
      venue: { name: 'PlaySpot Arena' }, court: { name: 'Court A' }, items, participants,
    };
  });

  Object.assign(prisma, {
    user: {
      findUnique: vi.fn(async () => ({ id: userId, role, status: 'ACTIVE' })),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => users.filter(user => where.id.in.includes(user.id)).map(user => ({ ...user, role: 'PLAYER', status: 'ACTIVE' }))),
    },
    vendorProfile: { findUnique: vi.fn(async () => ({ id: '88888888-8888-4888-8888-888888888888' })) },
    court: { findFirst: vi.fn(async () => options.ownsCourt === false ? null : court) },
    courtBlock: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    booking: {
      findMany: vi.fn(async () => []), findUnique: vi.fn(), count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => options.conflict ? { id: '99999999-9999-4999-8999-999999999999' } : null),
      create: createdBooking, update: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })),
    },
    bookingParticipant: { findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
    paymentContribution: { updateMany: vi.fn(async () => ({ count: 0 })) },
    equipmentItem: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.includes(equipmentId)
      ? [{ id: equipmentId, name: 'Ball set', priceMode: 'RENTAL', unitPricePaisa: 2500, quantityAvailable: 5 }]
      : []) },
    payment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: data.status,
        method: data.method, provider: data.provider, environment: data.environment,
        amountPaisa: data.amountPaisa, currency: 'PKR', providerReference: null, checkoutUrl: null,
        settledAt: null, createdAt: new Date(), ...data,
      })),
      findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })),
    },
    paymentStatusAudit: { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    $queryRaw: vi.fn(async () => []),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1', createBookingRouter({
    prisma: prisma as unknown as PrismaClient,
    accessSecret: secret,
    onlineProvider: { provider: 'SAFEPAY', environment: 'SANDBOX' },
  }));
  app.use(errorHandler);
  const token = createAccessToken(userId, role, secret);
  return { app, token, prisma, createdBooking };
}

describe('booking and walk-in routes', () => {
  it('calculates booking price from current court and add-on prices, ignoring client totals and payment status', async () => {
    const { app, token, createdBooking, prisma } = setup();
    const response = await request(app).post('/api/v1/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        courtId, date: futureDateKey(), startTime: '10:00', endTime: '11:00',
        addOns: [{ equipmentId, quantity: 2 }], totalPaisa: 1, totalPKR: 1, paymentStatus: 'PAID',
      });

    expect(response.status).toBe(201);
    expect(response.body.data.booking.totalPaisa).toBe(45_000);
    expect(response.body.data.booking.totalPKR).toBe(450);
    expect(response.body.data.booking.paymentStatus).toBe('PENDING');
    expect(response.body.data.booking.addOns[0]).toMatchObject({ name: 'Ball set', quantity: 2, unitPricePaisa: 2500, lineTotalPaisa: 5000 });
    expect(createdBooking).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      groundFeePaisa: 40_000, addOnsTotalPaisa: 5_000, totalPaisa: 45_000,
    }) }));
    expect((prisma.payment as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amountPaisa: 45_000, status: 'PENDING', provider: 'SAFEPAY' }),
    }));
  });

  it('creates equal participant contributions and returns only the authenticated player payment', async () => {
    const { app, token, prisma } = setup();
    const response = await request(app).post('/api/v1/bookings').set('Authorization', `Bearer ${token}`).send({
      courtId, date: futureDateKey(), startTime: '10:00', endTime: '11:00', participantUserIds: [otherPlayerId],
    });

    expect(response.status).toBe(201);
    expect(response.body.data.booking.participants).toHaveLength(2);
    expect(response.body.data.booking.participants.reduce((sum: number, item: { sharePaisa: number }) => sum + item.sharePaisa, 0)).toBe(40_000);
    expect((prisma.payment as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(2);
    expect(response.body.data.payment.amountPaisa).toBe(20_000);
  });

  it('rejects a closed or unavailable slot before writing a booking', async () => {
    const { app, token, prisma } = setup({ conflict: true });
    const response = await request(app).post('/api/v1/bookings').set('Authorization', `Bearer ${token}`).send({
      courtId, date: futureDateKey(), startTime: '10:00', endTime: '11:00',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SLOT_UNAVAILABLE');
    expect((prisma.booking as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('stores walk-ins in the same booking table and ignores a client supplied paid status', async () => {
    const { app, token, createdBooking, prisma } = setup({ role: 'VENDOR' });
    const response = await request(app).post('/api/v1/vendors/me/bookings/walk-in')
      .set('Authorization', `Bearer ${token}`)
      .send({ courtId, date: futureDateKey(), startTime: '10:00', endTime: '11:00', customerName: 'Walk-in Customer', paymentStatus: 'PAID', totalPaisa: 1 });

    expect(response.status).toBe(201);
    expect(response.body.data.booking.source).toBe('walk-in');
    expect(response.body.data.booking.paymentStatus).toBe('DUE_AT_VENUE');
    expect(response.body.data.payment).toMatchObject({ method: 'PAY_AT_VENUE', provider: 'MANUAL', status: 'DUE_AT_VENUE' });
    expect(createdBooking).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      source: 'WALK_IN', status: 'CONFIRMED', paymentStatus: 'DUE_AT_VENUE', totalPaisa: 40_000,
    }) }));
    expect((prisma.payment as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ purpose: 'WALK_IN_BOOKING', userId: null, status: 'DUE_AT_VENUE' }),
    }));
  });

  it('does not let a vendor add a walk-in to another vendor court', async () => {
    const { app, token, createdBooking } = setup({ role: 'VENDOR', ownsCourt: false });
    const response = await request(app).post('/api/v1/vendors/me/bookings/walk-in')
      .set('Authorization', `Bearer ${token}`)
      .send({ courtId, date: futureDateKey(), startTime: '10:00', endTime: '11:00', customerName: 'Walk-in Customer' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('COURT_NOT_FOUND');
    expect(createdBooking).not.toHaveBeenCalled();
  });
});
