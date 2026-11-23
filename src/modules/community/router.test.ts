import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createAccessToken } from '../auth/tokens.js';
import { RealtimeHub } from '../../realtime/hub.js';
import { createCommunityRouter } from './router.js';

const accessSecret = 'community-test-access-secret-long-enough';
const playerId = '11111111-1111-4111-8111-111111111111';
const vendorId = '22222222-2222-4222-8222-222222222222';
const venueId = '33333333-3333-4333-8333-333333333333';
const sportId = '44444444-4444-4444-8444-444444444444';
const conversationId = '55555555-5555-4555-8555-555555555555';

function setup(options: { role?: 'PLAYER' | 'VENDOR' } = {}) {
  const role = options.role ?? 'PLAYER';
  let lastGameRoomCreateData: Record<string, unknown> | null = null;
  const venue = {
    id: venueId, name: 'PlaySpot Arena', city: 'Lahore', timeZone: 'Asia/Karachi',
    vendorProfile: { ownerUserId: vendorId },
  };
  const conversation = {
    id: conversationId, kind: 'VENUE_VENDOR', title: 'PlaySpot Arena · venue chat',
    updatedAt: new Date('2026-11-15T10:00:00.000Z'), venue,
    members: [
      { user: { id: playerId, name: 'Player One', role: 'PLAYER' } },
      { user: { id: vendorId, name: 'Venue Owner', role: 'VENDOR' } },
    ], messages: [], gameRoom: null, tournament: null,
  };
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ id: role === 'VENDOR' ? vendorId : playerId, role, status: 'ACTIVE' })),
      findMany: vi.fn(async () => [{ id: playerId, name: 'Player One' }]),
    },
    venue: {
      findFirst: vi.fn(async () => ({ id: venueId, name: venue.name, vendorProfile: venue.vendorProfile })),
    },
    sport: { findFirst: vi.fn(async () => ({ id: sportId })) },
    court: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    courtBlock: { findFirst: vi.fn(async () => null) },
    booking: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: '99999999-9999-4999-8999-999999999999',
        participants: [{ id: 'participant-id', contribution: { id: 'contribution-id' } }],
        data,
      })),
      update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })),
    },
    bookingParticipant: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    paymentContribution: { update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    payment: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'payment-id', ...data })), findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 1 })) },
    paymentStatusAudit: { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 1 })) },
    gameRoomShare: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    conversation: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => conversation),
    },
    gameRoom: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        lastGameRoomCreateData = data;
        return {
          id: conversationId, title: 'Badminton tonight', locationLabel: 'PlaySpot Arena',
          bookingId: data.bookingId,
          startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000),
          timeZone: 'Asia/Karachi', visibility: 'PUBLIC', capacity: 4, totalCostPaisa: 0,
          perPlayerSharePaisa: 0, paymentMode: 'PAY_AT_VENUE', status: 'OPEN', createdAt: new Date(),
          organizerUserId: playerId, sport: { id: sportId, name: 'Badminton', code: 'badminton' },
          venue: { ...venue, vendorProfile: venue.vendorProfile }, court: null,
          members: [{ userId: playerId, role: 'ORGANIZER', seatIndex: 0, user: { id: playerId, name: 'Player One' } }],
        };
      }),
    },
    tournament: {
      create: vi.fn(async () => ({ id: '88888888-8888-4888-8888-888888888888' })),
      findUniqueOrThrow: vi.fn(async () => ({ id: '88888888-8888-4888-8888-888888888888' })),
      findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: '88888888-8888-4888-8888-888888888888', status: 'UPCOMING', registrationOpen: data.registrationOpen })),
    },
    tournamentParticipant: {
      groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: '99999999-9999-4999-8999-999999999999', ...data })),
    },
    notification: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data) },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    $queryRaw: vi.fn(async () => []),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createCommunityRouter({ prisma: prisma as unknown as PrismaClient, accessSecret, realtime: new RealtimeHub() }));
  app.use(errorHandler);
  const token = createAccessToken(role === 'VENDOR' ? vendorId : playerId, role, accessSecret);
  return { app, token, prisma, getLastGameRoomCreateData: () => lastGameRoomCreateData };
}

describe('community venue conversations', () => {
  it('reopens registration on the server for a future upcoming tournament owned by the vendor', async () => {
    const { app, token, prisma } = setup({ role: 'VENDOR' });
    const tournamentId = '88888888-8888-4888-8888-888888888888';
    vi.mocked(prisma.tournament.findFirst).mockResolvedValueOnce({
      id: tournamentId, status: 'UPCOMING', startsAt: new Date(Date.now() + 10 * 86_400_000),
      maxTeams: 8, registrationOpen: false, participants: [],
    } as never);
    const response = await request(app).patch(`/api/v1/tournaments/${tournamentId}/registration`)
      .set('Authorization', `Bearer ${token}`).send({ open: true });

    expect(response.status).toBe(200);
    expect(response.body.data.registrationOpen).toBe(true);
    expect(prisma.tournament.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: tournamentId }, data: { registrationOpen: true },
    }));
  });

  it('returns registered players and scores per sport on the common leaderboard', async () => {
    const { app, prisma } = setup();
    const badmintonTournamentId = '66666666-6666-4666-8666-666666666666';
    const cricketTournamentId = '77777777-7777-4777-8777-777777777777';
    vi.mocked(prisma.tournamentParticipant.groupBy).mockResolvedValueOnce([
      { userId: playerId, tournamentId: badmintonTournamentId, _sum: { wins: 1, points: 5 } },
      { userId: playerId, tournamentId: cricketTournamentId, _sum: { wins: 2, points: 8 } },
    ] as never);
    vi.mocked(prisma.tournament.findMany).mockResolvedValueOnce([
      { id: badmintonTournamentId, sport: { id: sportId, name: 'Badminton' } },
      { id: cricketTournamentId, sport: { id: '99999999-9999-4999-8999-999999999999', name: 'Cricket' } },
    ] as never);
    const response = await request(app).get('/api/v1/leaderboards?limit=50');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: playerId, playerName: 'Player One', sport: 'Badminton', wins: 1, points: 5 }),
      expect.objectContaining({ userId: playerId, playerName: 'Player One', sport: 'Cricket', wins: 2, points: 8 }),
    ]));
  });

  it('notifies the player when a team registration commits', async () => {
    const { app, token, prisma } = setup();
    const tournamentId = '88888888-8888-4888-8888-888888888888';
    vi.mocked(prisma.tournament.findUnique).mockResolvedValueOnce({
      id: tournamentId, organizerUserId: vendorId, title: 'Lahore Cup', maxTeams: 8,
      teamSize: 1, startsAt: new Date(Date.now() + 10 * 86_400_000), status: 'UPCOMING',
      registrationOpen: true, entryFeePerPlayerPaisa: 0, participants: [],
    } as never);
    const response = await request(app).post(`/api/v1/tournaments/${tournamentId}/teams`)
      .set('Authorization', `Bearer ${token}`).send({ teamName: 'Lahore Lions', teamMemberNames: [] });

    expect(response.status).toBe(201);
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(prisma.notification.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      userId: playerId, type: 'TOURNAMENT', payload: expect.objectContaining({ tournamentId }),
    }) }));
  });

  it('lists a player’s tournament registrations with server team counts for bookings refresh', async () => {
    const { app, token, prisma } = setup();
    const startsAt = new Date(Date.now() + 10 * 86_400_000);
    vi.mocked(prisma.tournament.findMany).mockResolvedValueOnce([{
      id: '88888888-8888-4888-8888-888888888888', title: 'Lahore Cup', startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000), createdAt: new Date(), updatedAt: new Date(),
      status: 'UPCOMING', registrationOpen: true, maxTeams: 8, teamSize: 1,
      registeredTeams: 1, _count: { participants: 1 }, participants: [{ userId: playerId, user: { id: playerId, name: 'Player One' } }],
      venue: { id: venueId, name: 'PlaySpot Arena', city: 'Lahore' },
      sport: { id: sportId, name: 'Badminton', code: 'badminton' }, organizer: { id: vendorId, name: 'Venue Owner' },
      reservations: [],
    }] as never);
    const response = await request(app).get('/api/v1/tournaments/me').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({ id: '88888888-8888-4888-8888-888888888888', registeredTeams: 1, registrationOpen: true });
    expect(prisma.tournament.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { participants: { some: { userId: playerId, status: 'REGISTERED' } } },
    }));
  });

  it('locks every selected tournament court and reserves it on the shared booking calendar', async () => {
    const { app, token, prisma } = setup({ role: 'VENDOR' });
    const tournamentId = '88888888-8888-4888-8888-888888888888';
    const courtId = '66666666-6666-4666-8666-666666666666';
    const eventDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    while (eventDate.getUTCDay() !== 6) eventDate.setUTCDate(eventDate.getUTCDate() + 1);
    const dateKey = eventDate.toISOString().slice(0, 10);
    const startsAt = new Date(`${dateKey}T06:00:00.000Z`);
    const endsAt = new Date(`${dateKey}T07:00:00.000Z`);
    vi.mocked(prisma.court.findMany).mockResolvedValueOnce([{
      id: courtId, name: 'Badminton Court A', venueId, sportId, hourlyPricePaisa: 50_000,
      slotDurationMinutes: 60, openingTime: '09:00', closingTime: '17:00', availableDays: ['Sat'],
      venue: { id: venueId, timeZone: 'Asia/Karachi' },
    }] as never);
    vi.mocked(prisma.tournament.findUniqueOrThrow).mockResolvedValueOnce({
      id: tournamentId, startsAt, endsAt,
    } as never);
    const response = await request(app).post('/api/v1/tournaments').set('Authorization', `Bearer ${token}`).send({
      venueId, sportId, courtIds: [courtId], title: 'Saturday Badminton Cup',
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
      maxTeams: 8, teamSize: 2, entryFeePerPlayerPaisa: 5_000, prizePaisa: 20_000,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.id).toBe(tournamentId);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.booking.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      tournamentId, source: 'TOURNAMENT', status: 'CONFIRMED', paymentStatus: 'PAID', totalPaisa: 0,
    }) }));
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('creates a persisted private venue chat with the authenticated player and the venue owner', async () => {
    const { app, token, prisma } = setup();
    const response = await request(app).post(`/api/v1/venues/${venueId}/conversations`)
      .set('Authorization', `Bearer ${token}`).send({});

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: conversationId, kind: 'VENUE_VENDOR', venueId, vendorUserId: vendorId, playerUserId: playerId,
      members: [{ id: playerId }, { id: vendorId }],
    });
    expect(prisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: 'VENUE_VENDOR', venueId,
        members: { create: [{ userId: playerId }, { userId: vendorId }] },
      }),
    }));
  });

  it('includes the selected venue vendor in a game room conversation', async () => {
    const { app, token, getLastGameRoomCreateData } = setup();
    const startsAt = new Date(Date.now() + 3_600_000).toISOString();
    const endsAt = new Date(Date.now() + 7_200_000).toISOString();
    await request(app).post('/api/v1/game-rooms').set('Authorization', `Bearer ${token}`).send({
      sportId, venueId, title: 'Badminton tonight', locationLabel: 'PlaySpot Arena',
      startsAt, endsAt, capacity: 4, visibility: 'PUBLIC', paymentMode: 'PAY_AT_VENUE',
    }).expect(201);

    const createData = getLastGameRoomCreateData() as {
      conversation: { create: { members: { create: Array<{ userId: string }> } } };
    };
    expect(createData.conversation.create.members.create).toEqual([{ userId: playerId }, { userId: vendorId }]);
  });

  it('reserves the selected court and creates balanced due-at-venue shares for a room', async () => {
    const { app, token, prisma, getLastGameRoomCreateData } = setup();
    vi.mocked(prisma.court.findFirst).mockResolvedValueOnce({
      id: '66666666-6666-4666-8666-666666666666', venueId, sportId, hourlyPricePaisa: 40_001,
      slotDurationMinutes: 60, openingTime: '09:00', closingTime: '17:00', availableDays: ['Sat'],
      venue: { id: venueId, timeZone: 'Asia/Karachi' },
    } as never);
    const eventDate = new Date();
    eventDate.setUTCDate(eventDate.getUTCDate() + 7);
    while (eventDate.getUTCDay() !== 6) eventDate.setUTCDate(eventDate.getUTCDate() + 1);
    const dateKey = eventDate.toISOString().slice(0, 10);
    const startsAt = `${dateKey}T06:00:00.000Z`;
    const endsAt = `${dateKey}T07:00:00.000Z`;
    const response = await request(app).post('/api/v1/game-rooms').set('Authorization', `Bearer ${token}`).send({
      sportId, venueId, courtId: '66666666-6666-4666-8666-666666666666', title: 'Badminton tonight',
      locationLabel: 'PlaySpot Arena', startsAt, endsAt, capacity: 4, visibility: 'PRIVATE', paymentMode: 'PAY_AT_VENUE',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.room.bookingId).toBe('99999999-9999-4999-8999-999999999999');
    const bookingCreate = vi.mocked(prisma.booking.create).mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(bookingCreate.data).toMatchObject({ source: 'APP', status: 'CONFIRMED', paymentMode: 'PAY_AT_VENUE', paymentStatus: 'DUE_AT_VENUE', totalPaisa: 40_001 });
    const roomCreate = getLastGameRoomCreateData() as { data?: unknown; bookingId?: string; shares: { create: Array<{ amountPaisa: number; seatIndex: number; status: string }> } };
    expect(roomCreate.bookingId).toBe('99999999-9999-4999-8999-999999999999');
    const roomWrite = (vi.mocked(prisma.gameRoom.create).mock.calls[0]?.[0] as { data: { shares: { create: Array<{ amountPaisa: number; seatIndex: number; status: string }> } } }).data;
    expect(roomWrite.shares.create.map(share => share.amountPaisa)).toEqual([10_001, 10_000, 10_000, 10_000]);
    expect(roomWrite.shares.create[0]).toMatchObject({ seatIndex: 0, status: 'DUE_AT_VENUE' });
    expect(vi.mocked(prisma.payment.create)).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      method: 'PAY_AT_VENUE', status: 'DUE_AT_VENUE', amountPaisa: 10_001, contributionId: 'contribution-id',
    }) }));
  });
});
