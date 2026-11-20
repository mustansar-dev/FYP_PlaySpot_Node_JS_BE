import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { apiError, apiSuccess } from '../../common/apiResponse.js';
import { HttpError } from '../../common/httpError.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import { sendMessage } from './chatService.js';
import { timeToMinutes, utcInstantToLocal, weekdayForDate } from '../bookings/schedule.js';
import { paisaToPKR } from '../bookings/service.js';
import {
  leaderboardQuerySchema, messageCreateSchema, messageListQuerySchema, roomCreateSchema, roomJoinSchema,
  roomListQuerySchema, standingsSchema, tournamentCreateSchema,
  tournamentCancelSchema, tournamentJoinSchema, tournamentListQuerySchema,
} from './schemas.js';

interface CommunityRouterOptions { prisma: PrismaClient; accessSecret: string; realtime: RealtimeHub; }

function invalid(response: Response, issues: { path: PropertyKey[]; message: string }[]): void {
  response.status(400).json(apiError('VALIDATION_ERROR', 'The request is invalid.', issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))));
}

function routeId(request: Request, name: string): string {
  const raw = request.params[name];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(400, 'INVALID_ID', `${name} must be a UUID.`);
  }
  return id;
}

function hashInvite(code: string): Buffer { return createHash('sha256').update(code).digest(); }
function inviteMatches(code: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const candidate = hashInvite(code);
  let stored: Buffer;
  try { stored = Buffer.from(storedHash, 'hex'); } catch { return false; }
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

function sharesForRoom(totalCostPaisa: number, capacity: number, organizerUserId: string) {
  const base = Math.floor(totalCostPaisa / capacity);
  const remainder = totalCostPaisa % capacity;
  return Array.from({ length: capacity }, (_, seatIndex) => {
    const amountPaisa = base + (seatIndex < remainder ? 1 : 0);
    const organizerSeat = seatIndex === 0;
    return {
      seatIndex,
      amountPaisa,
      userId: organizerSeat ? organizerUserId : null,
      status: amountPaisa === 0 ? 'PAID' as const : organizerSeat ? 'DUE_AT_VENUE' as const : 'OPEN' as const,
    };
  });
}

function assertTournamentCourtSchedule(court: {
  hourlyPricePaisa: number;
  slotDurationMinutes: number; openingTime: string; closingTime: string; availableDays: string[];
  venue: { timeZone: string };
}, startsAt: Date, endsAt: Date): number {
  const localStart = utcInstantToLocal(startsAt, court.venue.timeZone);
  const localEnd = utcInstantToLocal(endsAt, court.venue.timeZone);
  const startMinute = localStart ? timeToMinutes(localStart.time) : undefined;
  const endMinute = localEnd ? timeToMinutes(localEnd.time) : undefined;
  const opening = timeToMinutes(court.openingTime);
  const closing = timeToMinutes(court.closingTime);
  const weekday = localStart ? weekdayForDate(localStart.date) : undefined;
  const dayIsOpen = Boolean(weekday && court.availableDays.some(day => day.slice(0, 3).toLowerCase() === weekday.toLowerCase()));
  const duration = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (!localStart || !localEnd || localStart.date !== localEnd.date || startMinute === undefined || endMinute === undefined
    || opening === undefined || closing === undefined || !dayIsOpen
    || startMinute < opening || endMinute > closing || endMinute <= startMinute
    || (startMinute - opening) % court.slotDurationMinutes !== 0 || duration % court.slotDurationMinutes !== 0) {
    throw new HttpError(409, 'TOURNAMENT_COURT_SLOT_CLOSED', 'The tournament time does not fit every selected court schedule.');
  }
  return Math.round(court.hourlyPricePaisa * duration / 60);
}

function roomDto(room: {
  id: string; title: string; locationLabel: string; startsAt: Date; endsAt: Date; timeZone: string;
  visibility: string; capacity: number; totalCostPaisa: number; perPlayerSharePaisa: number; paymentMode: string;
  status: string; createdAt: Date; organizerUserId: string; sport: { id: string; name: string; code: string };
  bookingId: string | null;
  venue: { id: string; name: string; city: string; vendorProfile: { ownerUserId: string } } | null; court: { id: string; name: string } | null;
  members: Array<{ userId: string; role: string; seatIndex: number; user: { id: string; name: string } }>;
  shares?: Array<{ id: string; userId: string | null; seatIndex: number; amountPaisa: number; status: string }>;
}) {
  const shareBySeat = new Map((room.shares ?? []).map(share => [share.seatIndex, share]));
  return {
    id: room.id, title: room.title, locationLabel: room.locationLabel,
    startsAt: room.startsAt.toISOString(), endsAt: room.endsAt.toISOString(), timeZone: room.timeZone,
    visibility: room.visibility, capacity: room.capacity, memberCount: room.members.length,
    totalCostPaisa: room.totalCostPaisa, perPlayerSharePaisa: room.perPlayerSharePaisa,
    paymentMode: room.paymentMode, status: room.status, organizerUserId: room.organizerUserId,
    bookingId: room.bookingId,
    sport: room.sport,
    venue: room.venue ? { id: room.venue.id, name: room.venue.name, city: room.venue.city } : null,
    vendorUserId: room.venue?.vendorProfile.ownerUserId ?? null, court: room.court,
    members: room.members.map(member => {
      const share = shareBySeat.get(member.seatIndex);
      return {
        userId: member.userId, name: member.user.name, role: member.role, seatIndex: member.seatIndex,
        sharePaisa: share?.amountPaisa ?? room.perPlayerSharePaisa,
        sharePKR: paisaToPKR(share?.amountPaisa ?? room.perPlayerSharePaisa),
        paymentStatus: (share?.status ?? 'UNPAID').toLowerCase().replaceAll('_', '-'),
      };
    }),
    paymentShares: (room.shares ?? []).map(share => ({
      id: share.id, seatIndex: share.seatIndex, userId: share.userId,
      amountPaisa: share.amountPaisa, amountPKR: paisaToPKR(share.amountPaisa),
      status: share.status.toLowerCase().replaceAll('_', '-'),
    })),
    createdAt: room.createdAt.toISOString(),
  };
}

const roomInclude = {
  sport: { select: { id: true, name: true, code: true } },
  venue: { select: { id: true, name: true, city: true, vendorProfile: { select: { ownerUserId: true } } } },
  court: { select: { id: true, name: true } },
  members: { include: { user: { select: { id: true, name: true } } }, orderBy: { seatIndex: 'asc' as const } },
  shares: { orderBy: { seatIndex: 'asc' as const } },
} satisfies Prisma.GameRoomInclude;

async function releaseRoomSeat(tx: Prisma.TransactionClient, input: {
  roomId: string; bookingId: string | null; userId: string; actorUserId: string;
}): Promise<void> {
  if (input.bookingId) {
    const participant = await tx.bookingParticipant.findUnique({
      where: { bookingId_userId: { bookingId: input.bookingId, userId: input.userId } },
      include: { contribution: true },
    });
    if (participant?.contribution) {
      if (participant.contribution.amountPaidPaisa > 0) {
        throw new HttpError(409, 'ROOM_SHARE_REFUND_REQUIRED', 'This player has paid their share. A vendor must record any refund before the seat can be released.');
      }
      const payments = await tx.payment.findMany({
        where: { contributionId: participant.contribution.id, status: { in: ['PENDING', 'PROCESSING', 'DUE_AT_VENUE', 'AWAITING_TRANSFER', 'PROOF_SUBMITTED'] } },
        select: { id: true, status: true, amountPaisa: true },
      });
      if (payments.length) {
        await tx.payment.updateMany({ where: { id: { in: payments.map(payment => payment.id) } }, data: { status: 'CANCELLED' } });
        await tx.paymentStatusAudit.createMany({ data: payments.map(payment => ({
          paymentId: payment.id, actorUserId: input.actorUserId, previousStatus: payment.status,
          newStatus: 'CANCELLED' as const, amountPaisa: payment.amountPaisa, reason: 'GAME_ROOM_SEAT_RELEASED',
        })) });
      }
      await tx.paymentContribution.update({ where: { id: participant.contribution.id }, data: { status: 'FAILED' } });
      await tx.bookingParticipant.update({ where: { id: participant.id }, data: { paymentStatus: 'FAILED' } });
    }
  }
  await tx.gameRoomShare.updateMany({
    where: { gameRoomId: input.roomId, userId: input.userId, status: { not: 'PAID' } },
    data: { userId: null, status: 'OPEN' },
  });
}

async function cancelRoomBooking(tx: Prisma.TransactionClient, input: { bookingId: string; actorUserId: string; now: Date }): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "bookings" WHERE "id" = ${input.bookingId}::uuid FOR UPDATE`);
  const booking = await tx.booking.findUnique({ where: { id: input.bookingId }, select: { id: true, status: true } });
  if (!booking || ['CANCELLED', 'EXPIRED'].includes(booking.status)) return;
  const payments = await tx.payment.findMany({
    where: {
      OR: [
        { bookingId: input.bookingId },
        { contribution: { bookingParticipant: { bookingId: input.bookingId } } },
      ],
      status: { notIn: ['CANCELLED', 'EXPIRED', 'REFUNDED', 'REFUND_PENDING'] },
    }, select: { id: true, status: true, amountPaisa: true },
  });
  const refunded = payments.some(payment => payment.status === 'SUCCEEDED');
  const pending = payments.filter(payment => payment.status !== 'SUCCEEDED');
  const succeeded = payments.filter(payment => payment.status === 'SUCCEEDED');
  if (pending.length) {
    await tx.payment.updateMany({ where: { id: { in: pending.map(payment => payment.id) } }, data: { status: 'CANCELLED' } });
    await tx.paymentStatusAudit.createMany({ data: pending.map(payment => ({
      paymentId: payment.id, actorUserId: input.actorUserId, previousStatus: payment.status,
      newStatus: 'CANCELLED' as const, amountPaisa: payment.amountPaisa, reason: 'GAME_ROOM_CANCELLED',
    })) });
  }
  if (succeeded.length) {
    await tx.payment.updateMany({ where: { id: { in: succeeded.map(payment => payment.id) } }, data: { status: 'REFUND_PENDING' } });
    await tx.paymentStatusAudit.createMany({ data: succeeded.map(payment => ({
      paymentId: payment.id, actorUserId: input.actorUserId, previousStatus: 'SUCCEEDED' as const,
      newStatus: 'REFUND_PENDING' as const, amountPaisa: payment.amountPaisa, reason: 'GAME_ROOM_CANCELLED_REFUND_REQUIRED',
    })) });
  }
  await tx.paymentContribution.updateMany({
    where: { bookingParticipant: { bookingId: input.bookingId }, amountPaidPaisa: { gt: 0 } }, data: { status: 'REFUND_PENDING' },
  });
  await tx.paymentContribution.updateMany({
    where: { bookingParticipant: { bookingId: input.bookingId }, amountPaidPaisa: 0 }, data: { status: 'FAILED' },
  });
  await tx.booking.update({
    where: { id: input.bookingId },
    data: { status: 'CANCELLED', paymentStatus: refunded ? 'REFUND_PENDING' : 'FAILED', cancelledAt: input.now, holdExpiresAt: null },
  });
}

const conversationInclude = {
  members: { include: { user: { select: { id: true, name: true, role: true } } } },
  messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, include: { sender: { select: { id: true, name: true } } } },
  venue: { select: { id: true, name: true, vendorProfile: { select: { ownerUserId: true } } } },
  gameRoom: { select: { id: true, visibility: true, status: true } },
  tournament: { select: { id: true, status: true } },
} satisfies Prisma.ConversationInclude;

function conversationDto(row: Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>) {
  const player = row.members.find(member => member.user.role === 'PLAYER');
  const vendor = row.members.find(member => member.user.role === 'VENDOR');
  const lastMessage = row.messages[0];
  return {
    id: row.id, kind: row.kind, title: row.title, updatedAt: row.updatedAt.toISOString(),
    ...(row.venue ? { venueId: row.venue.id, venueName: row.venue.name } : {}),
    vendorUserId: row.venue?.vendorProfile.ownerUserId ?? vendor?.user.id ?? null,
    playerUserId: player?.user.id ?? null, playerName: player?.user.name ?? null,
    members: row.members.map(member => member.user),
    lastMessage: lastMessage ? {
      id: lastMessage.id, body: lastMessage.body, senderUserId: lastMessage.senderUserId,
      senderName: lastMessage.sender.name, createdAt: lastMessage.createdAt.toISOString(),
    } : null,
    gameRoom: row.gameRoom, tournament: row.tournament,
  };
}

export function createCommunityRouter({ prisma, accessSecret, realtime }: CommunityRouterOptions): Router {
  const router = Router();
  const authenticate = requireAuth(prisma, accessSecret);
  const playerOnly = requireRole('PLAYER');
  const vendorOnly = requireRole('VENDOR');

  router.post('/venues/:venueId/conversations', authenticate, playerOnly, async (request, response, next) => {
    try {
      const venueId = routeId(request, 'venueId');
      const conversation = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "venues" WHERE "id" = ${venueId}::uuid FOR UPDATE`);
        const venue = await tx.venue.findFirst({
          where: { id: venueId, published: true, deletedAt: null },
          select: { id: true, name: true, vendorProfile: { select: { ownerUserId: true } } },
        });
        if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
        const vendorUserId = venue.vendorProfile.ownerUserId;
        const existing = await tx.conversation.findFirst({
          where: {
            kind: 'VENUE_VENDOR', venueId,
            AND: [
              { members: { some: { userId: request.auth!.userId } } },
              { members: { some: { userId: vendorUserId } } },
            ],
          }, include: conversationInclude,
        });
        if (existing) return existing;
        return tx.conversation.create({
          data: {
            kind: 'VENUE_VENDOR', venueId, title: `${venue.name} · venue chat`,
            members: { create: [{ userId: request.auth!.userId }, { userId: vendorUserId }] },
          }, include: conversationInclude,
        });
      });
      response.status(200).json(apiSuccess(conversationDto(conversation)));
    } catch (error) { next(error); }
  });

  router.post('/game-rooms', authenticate, playerOnly, async (request, response, next) => {
    const parsed = roomCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const input = parsed.data;
      if (input.courtId && input.paymentMode !== 'PAY_AT_VENUE') {
        throw new HttpError(400, 'ROOM_PAYMENT_METHOD_UNAVAILABLE', 'Court-hosted room shares are due at the venue. Create a normal booking to use online or bank-transfer checkout.');
      }
      const inviteCode = input.visibility === 'PRIVATE' ? randomBytes(32).toString('base64url') : undefined;
      const roomId = randomUUID();
      const created = await prisma.$transaction(async tx => {
        const sport = await tx.sport.findFirst({ where: { id: input.sportId, isActive: true }, select: { id: true } });
        if (!sport) throw new HttpError(400, 'INVALID_SPORT', 'The selected sport is unavailable.');

        let venue: { id: string; name: string; vendorProfile: { ownerUserId: string } } | null = null;
        if (input.venueId) {
          venue = await tx.venue.findFirst({
            where: { id: input.venueId, deletedAt: null, published: true },
            select: { id: true, name: true, vendorProfile: { select: { ownerUserId: true } } },
          });
          if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
        }

        let totalCostPaisa = 0;
        let bookingId: string | null = null;
        if (input.courtId) {
          await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "courts" WHERE "id" = ${input.courtId}::uuid FOR UPDATE`);
          const court = await tx.court.findFirst({
            where: { id: input.courtId, venueId: input.venueId!, sportId: input.sportId, isActive: true },
            select: {
              id: true, venueId: true, sportId: true, hourlyPricePaisa: true, slotDurationMinutes: true,
              openingTime: true, closingTime: true, availableDays: true,
              venue: { select: { id: true, timeZone: true } },
            },
          });
          if (!court) throw new HttpError(404, 'COURT_NOT_FOUND', 'The selected court is not active at the selected venue/sport.');

          const localStart = utcInstantToLocal(input.startsAt, court.venue.timeZone);
          const localEnd = utcInstantToLocal(input.endsAt, court.venue.timeZone);
          const startMinute = localStart ? timeToMinutes(localStart.time) : undefined;
          const endMinute = localEnd ? timeToMinutes(localEnd.time) : undefined;
          const opening = timeToMinutes(court.openingTime);
          const closing = timeToMinutes(court.closingTime);
          const weekday = localStart ? weekdayForDate(localStart.date) : undefined;
          const dayIsOpen = Boolean(weekday && court.availableDays.some(day => day.slice(0, 3).toLowerCase() === weekday.toLowerCase()));
          const duration = (input.endsAt.getTime() - input.startsAt.getTime()) / 60_000;
          if (!localStart || !localEnd || localStart.date !== localEnd.date || startMinute === undefined || endMinute === undefined
            || opening === undefined || closing === undefined || !dayIsOpen
            || startMinute < opening || endMinute > closing || endMinute <= startMinute
            || (startMinute - opening) % court.slotDurationMinutes !== 0 || duration % court.slotDurationMinutes !== 0) {
            throw new HttpError(409, 'ROOM_SLOT_CLOSED', 'The selected room time does not fit the court operating schedule.');
          }

          const [block, overlap] = await Promise.all([
            tx.courtBlock.findFirst({ where: { courtId: court.id, startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt } }, select: { id: true } }),
            tx.booking.findFirst({
              where: {
                courtId: court.id, startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt },
                OR: [
                  { status: { in: ['CONFIRMED', 'COMPLETED'] } },
                  { status: 'PENDING_PAYMENT', holdExpiresAt: { gt: new Date() } },
                ],
              }, select: { id: true },
            }),
          ]);
          if (block) throw new HttpError(409, 'ROOM_SLOT_BLOCKED', 'The selected room time is blocked by the venue.');
          if (overlap) throw new HttpError(409, 'ROOM_SLOT_UNAVAILABLE', 'The selected court time is already reserved.');

          totalCostPaisa = Math.round(court.hourlyPricePaisa * duration / 60);
          if (!Number.isSafeInteger(totalCostPaisa)) throw new HttpError(400, 'INVALID_ROOM_PRICE', 'The room court price is outside the supported range.');
          const seatShares = sharesForRoom(totalCostPaisa, input.capacity, request.auth!.userId);
          const organizerShare = seatShares[0]!.amountPaisa;
          const booking = await tx.booking.create({
            data: {
              venueId: court.venueId, courtId: court.id, customerUserId: request.auth!.userId,
              createdByUserId: request.auth!.userId, source: 'APP', status: 'CONFIRMED',
              paymentMode: 'PAY_AT_VENUE', paymentStatus: totalCostPaisa ? 'DUE_AT_VENUE' : 'PAID',
              startsAt: input.startsAt, endsAt: input.endsAt, timeZone: court.venue.timeZone,
              groundFeePaisa: totalCostPaisa, addOnsTotalPaisa: 0, totalPaisa: totalCostPaisa,
              currency: 'PKR', holdExpiresAt: null,
              participants: { create: {
                userId: request.auth!.userId, isOrganizer: true, sharePaisa: organizerShare,
                paymentStatus: totalCostPaisa ? 'UNPAID' : 'PAID',
                contribution: { create: {
                  amountDuePaisa: organizerShare, amountPaidPaisa: 0,
                  status: totalCostPaisa ? 'UNPAID' : 'PAID',
                } },
              } },
            },
            select: { id: true, participants: { select: { id: true, contribution: { select: { id: true } } } } },
          });
          bookingId = booking.id;

          if (totalCostPaisa) {
            const contributionId = booking.participants[0]?.contribution?.id;
            if (!contributionId) throw new HttpError(500, 'ROOM_CONTRIBUTION_FAILED', 'The organizer payment share could not be created.');
            const payment = await tx.payment.create({ data: {
              userId: request.auth!.userId, provider: 'MANUAL', method: 'PAY_AT_VENUE', environment: 'MANUAL',
              purpose: 'BOOKING_CONTRIBUTION', status: 'DUE_AT_VENUE', amountPaisa: organizerShare,
              currency: 'PKR', contributionId, idempotencyKey: `game-room:${roomId}:seat:0`,
            } });
            await tx.paymentStatusAudit.create({ data: {
              paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: null,
              newStatus: 'DUE_AT_VENUE', amountPaisa: organizerShare, reason: 'GAME_ROOM_ORGANIZER_SHARE_DUE_AT_VENUE',
            } });
          }
        }

        const totalCostPaisaShares = sharesForRoom(totalCostPaisa, input.capacity, request.auth!.userId);
        return tx.gameRoom.create({
          data: {
            id: roomId, organizerUserId: request.auth!.userId, sportId: input.sportId, venueId: input.venueId ?? null,
            courtId: input.courtId ?? null, bookingId, title: input.title, locationLabel: input.locationLabel,
            startsAt: input.startsAt, endsAt: input.endsAt, visibility: input.visibility,
            inviteCodeHash: inviteCode ? hashInvite(inviteCode).toString('hex') : null,
            capacity: input.capacity, totalCostPaisa,
            perPlayerSharePaisa: Math.floor(totalCostPaisa / input.capacity), paymentMode: input.paymentMode,
            members: { create: { userId: request.auth!.userId, role: 'ORGANIZER', seatIndex: 0 } },
            shares: { create: totalCostPaisaShares.map(share => ({ ...share })) },
            conversation: { create: {
              kind: 'GAME_ROOM', title: input.title,
              members: { create: [...new Set([request.auth!.userId, venue?.vendorProfile.ownerUserId].filter((id): id is string => Boolean(id)))].map(userId => ({ userId })) },
            } },
          }, include: roomInclude,
        });
      });
      response.status(201).json(apiSuccess({ room: roomDto(created), ...(inviteCode ? { inviteCode } : {}) }));
    } catch (error) { next(error); }
  });

  router.get('/game-rooms', async (request, response, next) => {
    const parsed = roomListQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const { page, limit, sportId, city, from, to } = parsed.data;
      const where: Prisma.GameRoomWhereInput = {
        visibility: 'PUBLIC', status: 'OPEN', ...(sportId ? { sportId } : {}),
        ...(city ? { locationLabel: { contains: city, mode: 'insensitive' } } : {}),
        ...(from || to ? { startsAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.gameRoom.findMany({ where, include: roomInclude, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
        prisma.gameRoom.count({ where }),
      ]);
      response.status(200).json(apiSuccess(rows.map(roomDto), { page, limit, total }));
    } catch (error) { next(error); }
  });

  router.get('/game-rooms/me', authenticate, async (request, response, next) => {
    try {
      const rooms = await prisma.gameRoom.findMany({
        where: {
          OR: [
            { organizerUserId: request.auth!.userId },
            { members: { some: { userId: request.auth!.userId } } },
            ...(request.auth!.role === 'VENDOR' ? [{ venue: { vendorProfile: { ownerUserId: request.auth!.userId } } }] : []),
          ],
        },
        include: roomInclude,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      });
      response.status(200).json(apiSuccess(rooms.map(roomDto)));
    } catch (error) { next(error); }
  });

  router.post('/game-rooms/:roomId/invite', authenticate, playerOnly, async (request, response, next) => {
    try {
      const roomId = routeId(request, 'roomId');
      const inviteCode = randomBytes(32).toString('base64url');
      const changed = await prisma.gameRoom.updateMany({
        where: { id: roomId, organizerUserId: request.auth!.userId, visibility: 'PRIVATE', status: { in: ['OPEN', 'FULL'] } },
        data: { inviteCodeHash: hashInvite(inviteCode).toString('hex') },
      });
      if (!changed.count) throw new HttpError(404, 'PRIVATE_ROOM_NOT_FOUND', 'The private room was not found or is closed.');
      response.status(200).json(apiSuccess({ inviteCode }));
    } catch (error) { next(error); }
  });

  router.get('/game-rooms/:roomId', authenticate, async (request, response, next) => {
    try {
      const roomId = routeId(request, 'roomId');
      const room = await prisma.gameRoom.findUnique({ where: { id: roomId }, include: roomInclude });
      if (!room || (room.visibility === 'PRIVATE' && !room.members.some(member => member.userId === request.auth!.userId))) {
        throw new HttpError(404, 'ROOM_NOT_FOUND', 'The room was not found.');
      }
      response.status(200).json(apiSuccess(roomDto(room)));
    } catch (error) { next(error); }
  });

  router.post('/game-rooms/:roomId/join', authenticate, playerOnly, async (request, response, next) => {
    const parsed = roomJoinSchema.safeParse(request.body ?? {});
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const roomId = routeId(request, 'roomId');
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "game_rooms" WHERE "id" = ${roomId}::uuid FOR UPDATE`);
        const room = await tx.gameRoom.findUnique({ where: { id: roomId }, include: { members: { select: { userId: true, seatIndex: true } } } });
        if (!room || room.status !== 'OPEN' || room.startsAt <= new Date()) throw new HttpError(404, 'ROOM_NOT_FOUND', 'The room is not open for joining.');
        if (room.visibility === 'PRIVATE' && (!parsed.data.inviteCode || !inviteMatches(parsed.data.inviteCode, room.inviteCodeHash))) {
          throw new HttpError(403, 'INVALID_INVITE', 'A valid invite code is required to join this private room.');
        }
        if (room.members.some(member => member.userId === request.auth!.userId)) throw new HttpError(409, 'ALREADY_JOINED', 'You are already a member of this room.');
        if (room.members.length >= room.capacity) throw new HttpError(409, 'ROOM_FULL', 'This room has reached its capacity.');
        const occupied = new Set(room.members.map(member => member.seatIndex));
        let seatIndex = 0;
        while (occupied.has(seatIndex)) seatIndex += 1;
        const share = room.bookingId ? await tx.gameRoomShare.findUnique({
          where: { gameRoomId_seatIndex: { gameRoomId: roomId, seatIndex } },
        }) : null;
        if (room.bookingId && (!share || share.status !== 'OPEN' || share.userId)) {
          throw new HttpError(409, 'ROOM_SHARE_UNAVAILABLE', 'This room seat is no longer available.');
        }
        if (room.bookingId) {
          if (!share) throw new HttpError(409, 'ROOM_SHARE_UNAVAILABLE', 'This room seat is no longer available.');
          const booking = await tx.booking.findUnique({ where: { id: room.bookingId }, select: { id: true, status: true, startsAt: true } });
          if (!booking || booking.status !== 'CONFIRMED' || booking.startsAt <= new Date()) {
            throw new HttpError(409, 'ROOM_BOOKING_UNAVAILABLE', 'The venue reservation is no longer active.');
          }
          const priorParticipant = await tx.bookingParticipant.findUnique({
            where: { bookingId_userId: { bookingId: booking.id, userId: request.auth!.userId } },
            include: { contribution: true },
          });
          if (priorParticipant?.contribution && priorParticipant.contribution.amountPaidPaisa > 0) {
            throw new HttpError(409, 'ROOM_SHARE_ALREADY_PAID', 'This player already paid a share for this venue booking.');
          }
          const amountDuePaisa = share.amountPaisa;
          const contributionStatus = amountDuePaisa === 0 ? 'PAID' as const : 'UNPAID' as const;
          const participant = priorParticipant
            ? await tx.bookingParticipant.update({
              where: { id: priorParticipant.id },
              data: {
                sharePaisa: amountDuePaisa, paymentStatus: contributionStatus,
                contribution: { upsert: {
                  create: { amountDuePaisa, amountPaidPaisa: 0, status: contributionStatus },
                  update: { amountDuePaisa, amountPaidPaisa: 0, status: contributionStatus },
                } },
              }, include: { contribution: true },
            })
            : await tx.bookingParticipant.create({
              data: {
                bookingId: booking.id, userId: request.auth!.userId, sharePaisa: amountDuePaisa,
                paymentStatus: contributionStatus,
                contribution: { create: { amountDuePaisa, amountPaidPaisa: 0, status: contributionStatus } },
              }, include: { contribution: true },
            });
          if (amountDuePaisa > 0 && participant.contribution) {
            const payment = await tx.payment.create({ data: {
              userId: request.auth!.userId, provider: 'MANUAL', method: 'PAY_AT_VENUE', environment: 'MANUAL',
              purpose: 'BOOKING_CONTRIBUTION', status: 'DUE_AT_VENUE', amountPaisa: amountDuePaisa,
              currency: 'PKR', contributionId: participant.contribution.id, idempotencyKey: `game-room:${roomId}:member:${request.auth!.userId}:${randomUUID()}`,
            } });
            await tx.paymentStatusAudit.create({ data: {
              paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: null,
              newStatus: 'DUE_AT_VENUE', amountPaisa: amountDuePaisa, reason: 'GAME_ROOM_MEMBER_SHARE_DUE_AT_VENUE',
            } });
          }
          await tx.gameRoomShare.update({
            where: { gameRoomId_seatIndex: { gameRoomId: roomId, seatIndex } },
            data: { userId: request.auth!.userId, status: amountDuePaisa === 0 ? 'PAID' : 'DUE_AT_VENUE' },
          });
        }
        await tx.gameRoomMember.create({ data: { gameRoomId: roomId, userId: request.auth!.userId, role: 'PLAYER', seatIndex } });
        const conversation = await tx.conversation.findUnique({ where: { gameRoomId: roomId }, select: { id: true } });
        if (conversation) await tx.conversationMember.create({ data: { conversationId: conversation.id, userId: request.auth!.userId } });
        const count = room.members.length + 1;
        await tx.gameRoom.update({ where: { id: roomId }, data: { status: count >= room.capacity ? 'FULL' : 'OPEN' } });
        return { joined: true, memberCount: count, status: count >= room.capacity ? 'FULL' : 'OPEN' };
      });
      response.status(200).json(apiSuccess(result));
    } catch (error) { next(error); }
  });

  router.delete('/game-rooms/:roomId/members/me', authenticate, playerOnly, async (request, response, next) => {
    try {
      const roomId = routeId(request, 'roomId');
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "game_rooms" WHERE "id" = ${roomId}::uuid FOR UPDATE`);
        const room = await tx.gameRoom.findUnique({ where: { id: roomId }, select: { id: true, status: true, organizerUserId: true, bookingId: true, members: { select: { userId: true } } } });
        if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', 'The room was not found.');
        if (room.organizerUserId === request.auth!.userId) throw new HttpError(409, 'HOST_CANNOT_LEAVE', 'The host must close the room instead of leaving it.');
        await releaseRoomSeat(tx, { roomId, bookingId: room.bookingId, userId: request.auth!.userId, actorUserId: request.auth!.userId });
        await tx.gameRoomMember.deleteMany({ where: { gameRoomId: roomId, userId: request.auth!.userId } });
        const conversation = await tx.conversation.findUnique({ where: { gameRoomId: roomId }, select: { id: true } });
        if (conversation) await tx.conversationMember.deleteMany({ where: { conversationId: conversation.id, userId: request.auth!.userId } });
        const remaining = Math.max(0, room.members.length - 1);
        const status = room.status === 'FULL' ? 'OPEN' : room.status;
        await tx.gameRoom.update({ where: { id: roomId }, data: { status } });
        return { left: true, memberCount: remaining, status };
      });
      response.status(200).json(apiSuccess(result));
    } catch (error) { next(error); }
  });

  router.delete('/game-rooms/:roomId/members/:userId', authenticate, playerOnly, async (request, response, next) => {
    try {
      const roomId = routeId(request, 'roomId');
      const targetUserId = routeId(request, 'userId');
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "game_rooms" WHERE "id" = ${roomId}::uuid FOR UPDATE`);
        const room = await tx.gameRoom.findUnique({ where: { id: roomId }, select: { id: true, organizerUserId: true, status: true, capacity: true, bookingId: true, members: { select: { userId: true } } } });
        if (!room || room.organizerUserId !== request.auth!.userId) throw new HttpError(404, 'ROOM_NOT_FOUND', 'The room was not found.');
        if (targetUserId === room.organizerUserId) throw new HttpError(409, 'HOST_CANNOT_BE_REMOVED', 'The room host cannot be removed.');
        await releaseRoomSeat(tx, { roomId, bookingId: room.bookingId, userId: targetUserId, actorUserId: request.auth!.userId });
        const removed = await tx.gameRoomMember.deleteMany({ where: { gameRoomId: roomId, userId: targetUserId } });
        if (!removed.count) throw new HttpError(404, 'ROOM_MEMBER_NOT_FOUND', 'The room member was not found.');
        const conversation = await tx.conversation.findUnique({ where: { gameRoomId: roomId }, select: { id: true } });
        if (conversation) await tx.conversationMember.deleteMany({ where: { conversationId: conversation.id, userId: targetUserId } });
        const memberCount = room.members.length - 1;
        const status = room.status === 'FULL' && memberCount < room.capacity ? 'OPEN' : room.status;
        await tx.gameRoom.update({ where: { id: roomId }, data: { status } });
        return { removed: true, memberCount, status };
      });
      response.status(200).json(apiSuccess(result));
    } catch (error) { next(error); }
  });

  router.post('/game-rooms/:roomId/close', authenticate, playerOnly, async (request, response, next) => {
    try {
      const roomId = routeId(request, 'roomId');
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "game_rooms" WHERE "id" = ${roomId}::uuid FOR UPDATE`);
        const room = await tx.gameRoom.findFirst({
          where: { id: roomId, organizerUserId: request.auth!.userId, status: { in: ['OPEN', 'FULL'] } },
          select: { id: true, bookingId: true, startsAt: true },
        });
        if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', 'The room was not found or is already closed.');
        const now = new Date();
        if (room.startsAt <= now) throw new HttpError(409, 'ROOM_ALREADY_STARTED', 'A room cannot be closed after its scheduled start.');
        await tx.gameRoom.update({ where: { id: roomId }, data: { status: 'CLOSED' } });
        if (room.bookingId) await cancelRoomBooking(tx, { bookingId: room.bookingId, actorUserId: request.auth!.userId, now });
        return { closed: true, bookingReleased: Boolean(room.bookingId) };
      });
      response.status(200).json(apiSuccess(result));
    } catch (error) { next(error); }
  });

  router.get('/conversations', authenticate, async (request, response, next) => {
    try {
      const rows = await prisma.conversation.findMany({
        where: { members: { some: { userId: request.auth!.userId } } },
        include: conversationInclude, orderBy: { updatedAt: 'desc' },
      });
      response.status(200).json(apiSuccess(rows.map(conversationDto)));
    } catch (error) { next(error); }
  });

  router.get('/conversations/:conversationId/messages', authenticate, async (request, response, next) => {
    const parsed = messageListQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const conversationId = routeId(request, 'conversationId');
      const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId: request.auth!.userId } } });
      if (!member) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', 'The conversation was not found.');
      const messages = await prisma.message.findMany({
        where: { conversationId, ...(parsed.data.before ? { createdAt: { lt: parsed.data.before } } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: parsed.data.limit,
        include: { sender: { select: { id: true, name: true } } },
      });
      await prisma.conversationMember.update({ where: { conversationId_userId: { conversationId, userId: request.auth!.userId } }, data: { lastReadAt: new Date() } });
      const data = messages.reverse().map(message => ({
        id: message.id, conversationId, senderUserId: message.senderUserId, senderName: message.sender.name,
        body: message.body, createdAt: message.createdAt.toISOString(),
      }));
      response.status(200).json(apiSuccess(data, { page: 1, limit: parsed.data.limit, total: data.length }));
    } catch (error) { next(error); }
  });

  router.post('/conversations/:conversationId/messages', authenticate, async (request, response, next) => {
    const parsed = messageCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const conversationId = routeId(request, 'conversationId');
      const message = await sendMessage(prisma, realtime, conversationId, request.auth!.userId, parsed.data.body);
      response.status(201).json(apiSuccess(message));
    } catch (error) { next(error); }
  });

  router.get('/tournaments', async (request, response, next) => {
    const parsed = tournamentListQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const { page, limit, sportId, status } = parsed.data;
      const where: Prisma.TournamentWhereInput = { ...(sportId ? { sportId } : {}), ...(status ? { status } : {}) };
      const [items, total] = await Promise.all([
        prisma.tournament.findMany({ where, include: { venue: { select: { id: true, name: true, city: true } }, sport: { select: { id: true, name: true, code: true } }, organizer: { select: { id: true, name: true } }, _count: { select: { participants: { where: { status: 'REGISTERED' } } } } }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
        prisma.tournament.count({ where }),
      ]);
      response.status(200).json(apiSuccess(items.map(item => ({
        ...item, startsAt: item.startsAt.toISOString(), endsAt: item.endsAt.toISOString(), createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
        registeredTeams: item._count.participants,
      })), { page, limit, total }));
    } catch (error) { next(error); }
  });

  router.post('/tournaments', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = tournamentCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const input = parsed.data;
      const { courtIds, ...tournamentInput } = input;
      const tournament = await prisma.$transaction(async tx => {
        const venue = await tx.venue.findFirst({
          where: { id: input.venueId, deletedAt: null, vendorProfile: { ownerUserId: request.auth!.userId } },
          select: { id: true, timeZone: true },
        });
        if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
        const sport = await tx.sport.findFirst({ where: { id: input.sportId, isActive: true }, select: { id: true } });
        if (!sport) throw new HttpError(400, 'INVALID_SPORT', 'The selected sport is unavailable.');

        const orderedCourtIds = [...courtIds].sort();
        for (const courtId of orderedCourtIds) {
          await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "courts" WHERE "id" = ${courtId}::uuid FOR UPDATE`);
        }
        const courts = await tx.court.findMany({
          where: { id: { in: orderedCourtIds }, venueId: venue.id, sportId: sport.id, isActive: true },
          select: {
            id: true, name: true, venueId: true, sportId: true, hourlyPricePaisa: true,
            slotDurationMinutes: true, openingTime: true, closingTime: true, availableDays: true,
            venue: { select: { id: true, timeZone: true } },
          },
        });
        if (courts.length !== orderedCourtIds.length) throw new HttpError(400, 'INVALID_TOURNAMENT_COURT', 'Choose active courts for this sport at the selected venue.');

        const reservationCosts = new Map<string, number>();
        for (const court of courts) {
          const amountPaisa = assertTournamentCourtSchedule(court, input.startsAt, input.endsAt);
          if (!Number.isSafeInteger(amountPaisa) || amountPaisa > 2_000_000_000) {
            throw new HttpError(400, 'TOURNAMENT_COURT_PRICE_INVALID', 'The tournament court price is outside the supported range.');
          }
          const [block, overlap] = await Promise.all([
            tx.courtBlock.findFirst({ where: { courtId: court.id, startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt } }, select: { id: true } }),
            tx.booking.findFirst({
              where: {
                courtId: court.id, startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt },
                OR: [
                  { status: { in: ['CONFIRMED', 'COMPLETED'] } },
                  { status: 'PENDING_PAYMENT', holdExpiresAt: { gt: new Date() } },
                ],
              }, select: { id: true },
            }),
          ]);
          if (block) throw new HttpError(409, 'TOURNAMENT_COURT_BLOCKED', 'A selected court is blocked during the tournament time.');
          if (overlap) throw new HttpError(409, 'TOURNAMENT_COURT_UNAVAILABLE', 'A selected court already has a booking during the tournament time.');
          reservationCosts.set(court.id, amountPaisa);
        }

        const created = await tx.tournament.create({ data: {
          ...tournamentInput, organizerUserId: request.auth!.userId, timeZone: venue.timeZone,
          conversation: { create: { kind: 'TOURNAMENT', title: input.title, members: { create: { userId: request.auth!.userId } } } },
        }, include: {
          venue: { select: { id: true, name: true, city: true } },
          sport: { select: { id: true, name: true, code: true } },
          organizer: { select: { id: true, name: true } },
        } });

        for (const court of courts) {
          const totalPaisa = reservationCosts.get(court.id)!;
          const booking = await tx.booking.create({ data: {
            venueId: court.venueId, courtId: court.id, customerUserId: request.auth!.userId,
            createdByUserId: request.auth!.userId, tournamentId: created.id,
            source: 'TOURNAMENT', status: 'CONFIRMED', paymentMode: 'PAY_AT_VENUE',
            paymentStatus: totalPaisa > 0 ? 'DUE_AT_VENUE' : 'PAID',
            startsAt: input.startsAt, endsAt: input.endsAt, timeZone: court.venue.timeZone,
            groundFeePaisa: totalPaisa, addOnsTotalPaisa: 0, totalPaisa, currency: 'PKR', holdExpiresAt: null,
          }, select: { id: true } });
          if (totalPaisa > 0) {
            const payment = await tx.payment.create({ data: {
              userId: request.auth!.userId, provider: 'MANUAL', method: 'PAY_AT_VENUE', environment: 'MANUAL',
              purpose: 'WALK_IN_BOOKING', status: 'DUE_AT_VENUE', amountPaisa: totalPaisa, currency: 'PKR',
              bookingId: booking.id, idempotencyKey: `tournament:${created.id}:court:${court.id}`,
            } });
            await tx.paymentStatusAudit.create({ data: {
              paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: null,
              newStatus: 'DUE_AT_VENUE', amountPaisa: totalPaisa, reason: 'TOURNAMENT_COURT_RESERVATION_DUE_AT_VENUE',
            } });
          }
        }
        return tx.tournament.findUniqueOrThrow({ where: { id: created.id }, include: {
          venue: { select: { id: true, name: true, city: true } },
          sport: { select: { id: true, name: true, code: true } },
          organizer: { select: { id: true, name: true } },
          reservations: { include: { court: { select: { id: true, name: true } } }, orderBy: { startsAt: 'asc' } },
        } });
      });
      response.status(201).json(apiSuccess({ ...tournament, startsAt: tournament.startsAt.toISOString(), endsAt: tournament.endsAt.toISOString() }));
    } catch (error) { next(error); }
  });

  router.get('/tournaments/:tournamentId', async (request, response, next) => {
    try {
      const tournamentId = routeId(request, 'tournamentId');
      const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId }, include: {
        venue: { select: { id: true, name: true, city: true } }, sport: { select: { id: true, name: true, code: true } }, organizer: { select: { id: true, name: true } },
        reservations: { where: { status: { not: 'CANCELLED' } }, include: { court: { select: { id: true, name: true } } }, orderBy: { startsAt: 'asc' } },
        participants: { where: { status: 'REGISTERED' }, include: { user: { select: { id: true, name: true } } }, orderBy: [{ points: 'desc' }, { wins: 'desc' }, { joinedAt: 'asc' }] },
      } });
      if (!tournament) throw new HttpError(404, 'TOURNAMENT_NOT_FOUND', 'The tournament was not found.');
      response.status(200).json(apiSuccess({ ...tournament, startsAt: tournament.startsAt.toISOString(), endsAt: tournament.endsAt.toISOString(), createdAt: tournament.createdAt.toISOString(), updatedAt: tournament.updatedAt.toISOString() }));
    } catch (error) { next(error); }
  });

  router.post('/tournaments/:tournamentId/teams', authenticate, playerOnly, async (request, response, next) => {
    const parsed = tournamentJoinSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const tournamentId = routeId(request, 'tournamentId');
      const participant = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "tournaments" WHERE "id" = ${tournamentId}::uuid FOR UPDATE`);
        const tournament = await tx.tournament.findUnique({ where: { id: tournamentId }, select: { id: true, maxTeams: true, teamSize: true, startsAt: true, status: true, registrationOpen: true, entryFeePerPlayerPaisa: true, participants: { where: { status: 'REGISTERED' }, select: { id: true } } } });
        if (!tournament) throw new HttpError(404, 'TOURNAMENT_NOT_FOUND', 'The tournament was not found.');
        if (!tournament.registrationOpen || tournament.status !== 'UPCOMING' || tournament.startsAt <= new Date()) throw new HttpError(409, 'REGISTRATION_CLOSED', 'Tournament registration is closed.');
        if (tournament.participants.length >= tournament.maxTeams) throw new HttpError(409, 'TOURNAMENT_FULL', 'The tournament has reached its team limit.');
        const teamMemberNames = parsed.data.teamMemberNames;
        if (teamMemberNames.length !== tournament.teamSize - 1) {
          throw new HttpError(400, 'TOURNAMENT_TEAM_SIZE_MISMATCH', `Enter exactly ${tournament.teamSize - 1} teammate name(s).`);
        }
        if (new Set(teamMemberNames.map(name => name.toLocaleLowerCase())).size !== teamMemberNames.length) {
          throw new HttpError(400, 'DUPLICATE_TEAM_MEMBER', 'Each teammate name must be unique.');
        }
        const existing = await tx.tournamentParticipant.findUnique({ where: { tournamentId_userId: { tournamentId, userId: request.auth!.userId } } });
        if (existing && existing.status !== 'WITHDRAWN') throw new HttpError(409, 'ALREADY_REGISTERED', 'You already have a team registered.');
        const totalEntryFeePaisa = tournament.entryFeePerPlayerPaisa * tournament.teamSize;
        if (!Number.isSafeInteger(totalEntryFeePaisa) || totalEntryFeePaisa > 2_000_000_000) {
          throw new HttpError(400, 'TOURNAMENT_ENTRY_FEE_TOO_HIGH', 'The total entry fee for one team is outside the supported range.');
        }
        const data = {
          teamName: parsed.data.teamName, teamMemberNames,
          entryFeePerPlayerPaisa: tournament.entryFeePerPlayerPaisa,
          totalEntryFeePaisa,
          status: 'REGISTERED' as const, paymentStatus: totalEntryFeePaisa > 0 ? 'UNPAID' as const : 'PAID' as const,
        };
        const result = existing
          ? await tx.tournamentParticipant.update({ where: { id: existing.id }, data })
          : await tx.tournamentParticipant.create({ data: { tournamentId, userId: request.auth!.userId, ...data } });
        const conversation = await tx.conversation.findUnique({ where: { tournamentId }, select: { id: true } });
        if (conversation) await tx.conversationMember.upsert({ where: { conversationId_userId: { conversationId: conversation.id, userId: request.auth!.userId } }, create: { conversationId: conversation.id, userId: request.auth!.userId }, update: {} });
        return result;
      });
      response.status(201).json(apiSuccess(participant));
    } catch (error) { next(error); }
  });

  router.delete('/tournaments/:tournamentId/teams/me', authenticate, playerOnly, async (request, response, next) => {
    try {
      const tournamentId = routeId(request, 'tournamentId');
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "tournaments" WHERE "id" = ${tournamentId}::uuid FOR UPDATE`);
        const participant = await tx.tournamentParticipant.findUnique({ where: { tournamentId_userId: { tournamentId, userId: request.auth!.userId } } });
        if (!participant || participant.status !== 'REGISTERED') throw new HttpError(404, 'TEAM_NOT_FOUND', 'Your registered team was not found.');
        if (participant.paymentStatus === 'PAID') {
          const payments = await tx.payment.findMany({ where: { tournamentParticipantId: participant.id, status: 'SUCCEEDED' }, select: { id: true, amountPaisa: true } });
          if (payments.length) {
            await tx.payment.updateMany({ where: { id: { in: payments.map(payment => payment.id) } }, data: { status: 'REFUND_PENDING' } });
            await tx.paymentStatusAudit.createMany({ data: payments.map(payment => ({
              paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: 'SUCCEEDED' as const,
              newStatus: 'REFUND_PENDING' as const, amountPaisa: payment.amountPaisa, reason: 'TOURNAMENT_TEAM_WITHDRAWN_REFUND_REQUIRED',
            })) });
          }
        }
        const unpaidPayments = await tx.payment.findMany({
          where: { tournamentParticipantId: participant.id, status: { in: ['PENDING', 'PROCESSING', 'DUE_AT_VENUE', 'AWAITING_TRANSFER', 'PROOF_SUBMITTED'] } },
          select: { id: true, status: true, amountPaisa: true },
        });
        if (unpaidPayments.length) {
          await tx.payment.updateMany({ where: { id: { in: unpaidPayments.map(payment => payment.id) } }, data: { status: 'CANCELLED' } });
          await tx.paymentStatusAudit.createMany({ data: unpaidPayments.map(payment => ({
            paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: payment.status,
            newStatus: 'CANCELLED' as const, amountPaisa: payment.amountPaisa, reason: 'TOURNAMENT_TEAM_WITHDRAWN',
          })) });
        }
        const paid = participant.paymentStatus === 'PAID';
        await tx.tournamentParticipant.update({ where: { id: participant.id }, data: {
          status: 'WITHDRAWN', paymentStatus: paid ? 'REFUND_PENDING' : 'FAILED',
        } });
        const conversation = await tx.conversation.findUnique({ where: { tournamentId }, select: { id: true } });
        if (conversation) await tx.conversationMember.deleteMany({ where: { conversationId: conversation.id, userId: request.auth!.userId } });
        return { withdrawn: true, refundStatus: paid ? 'REFUND_PENDING' : 'NOT_APPLICABLE' };
      });
      response.status(200).json(apiSuccess(result));
    } catch (error) { next(error); }
  });

  router.put('/tournaments/:tournamentId/standings', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = standingsSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const tournamentId = routeId(request, 'tournamentId');
      const tournament = await prisma.tournament.findFirst({ where: { id: tournamentId, organizerUserId: request.auth!.userId } });
      if (!tournament) throw new HttpError(404, 'TOURNAMENT_NOT_FOUND', 'The tournament was not found.');
      const participants = await prisma.tournamentParticipant.findMany({ where: { tournamentId, status: 'REGISTERED' }, select: { id: true } });
      const participantIds = new Set(participants.map(item => item.id));
      if (parsed.data.results.some(result => !participantIds.has(result.participantId))) throw new HttpError(400, 'INVALID_STANDING_PARTICIPANT', 'Every result must refer to a registered participant in this tournament.');
      const updated = await prisma.$transaction(async tx => {
        for (const result of parsed.data.results) await tx.tournamentParticipant.update({ where: { id: result.participantId }, data: { wins: result.wins, points: result.points } });
        return tx.tournament.update({ where: { id: tournamentId }, data: {
          status: parsed.data.status,
          registrationOpen: parsed.data.status === 'ACTIVE' ? false : tournament.registrationOpen,
          ...(parsed.data.winnerTeamName ? { winnerTeamName: parsed.data.winnerTeamName } : {}),
        } });
      });
      response.status(200).json(apiSuccess({ id: updated.id, status: updated.status, winnerTeamName: updated.winnerTeamName }));
    } catch (error) { next(error); }
  });

  router.post('/tournaments/:tournamentId/cancel', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = tournamentCancelSchema.safeParse(request.body ?? {});
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const tournamentId = routeId(request, 'tournamentId');
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "tournaments" WHERE "id" = ${tournamentId}::uuid FOR UPDATE`);
        const tournament = await tx.tournament.findFirst({
          where: { id: tournamentId, organizerUserId: request.auth!.userId, status: { in: ['UPCOMING', 'ACTIVE'] } },
          select: { id: true },
        });
        if (!tournament) throw new HttpError(404, 'TOURNAMENT_NOT_FOUND', 'The tournament was not found or already ended.');
        await tx.tournament.update({ where: { id: tournamentId }, data: { status: 'CANCELLED', registrationOpen: false } });

        const participants = await tx.tournamentParticipant.findMany({ where: { tournamentId, status: 'REGISTERED' }, select: { id: true, paymentStatus: true } });
        const bookings = await tx.booking.findMany({ where: { tournamentId, status: { notIn: ['CANCELLED', 'COMPLETED'] } }, select: { id: true } });
        const targetPayments = await tx.payment.findMany({
          where: {
            OR: [
              ...(participants.length ? [{ tournamentParticipantId: { in: participants.map(participant => participant.id) } }] : []),
              ...(bookings.length ? [{ bookingId: { in: bookings.map(booking => booking.id) } }] : []),
            ],
            status: { notIn: ['CANCELLED', 'EXPIRED', 'REFUNDED', 'REFUND_PENDING'] },
          }, select: { id: true, status: true, amountPaisa: true, tournamentParticipantId: true, bookingId: true },
        });
        const succeeded = targetPayments.filter(payment => payment.status === 'SUCCEEDED');
        const cancelable = targetPayments.filter(payment => payment.status !== 'SUCCEEDED');
        if (succeeded.length) {
          await tx.payment.updateMany({ where: { id: { in: succeeded.map(payment => payment.id) } }, data: { status: 'REFUND_PENDING' } });
          await tx.paymentStatusAudit.createMany({ data: succeeded.map(payment => ({
            paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: 'SUCCEEDED' as const,
            newStatus: 'REFUND_PENDING' as const, amountPaisa: payment.amountPaisa, reason: parsed.data.reason || 'TOURNAMENT_CANCELLED_REFUND_REQUIRED',
          })) });
        }
        if (cancelable.length) {
          await tx.payment.updateMany({ where: { id: { in: cancelable.map(payment => payment.id) } }, data: { status: 'CANCELLED' } });
          await tx.paymentStatusAudit.createMany({ data: cancelable.map(payment => ({
            paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: payment.status,
            newStatus: 'CANCELLED' as const, amountPaisa: payment.amountPaisa, reason: parsed.data.reason || 'TOURNAMENT_CANCELLED',
          })) });
        }
        const refundedParticipantIds = new Set(succeeded.map(payment => payment.tournamentParticipantId).filter((id): id is string => Boolean(id)));
        for (const participant of participants) await tx.tournamentParticipant.update({
          where: { id: participant.id },
          data: { paymentStatus: refundedParticipantIds.has(participant.id) ? 'REFUND_PENDING' : 'FAILED' },
        });
        for (const booking of bookings) {
          const hasPaid = succeeded.some(payment => payment.bookingId === booking.id);
          await tx.booking.update({ where: { id: booking.id }, data: {
            status: 'CANCELLED', paymentStatus: hasPaid ? 'REFUND_PENDING' : 'FAILED', cancelledAt: new Date(), holdExpiresAt: null,
          } });
        }
        return { cancelled: true, refundStatus: succeeded.length ? 'REFUND_PENDING' : 'NOT_APPLICABLE' };
      });
      response.status(200).json(apiSuccess({ ...result, reason: parsed.data.reason ?? null }));
    } catch (error) { next(error); }
  });

  router.get('/tournaments/:tournamentId/leaderboard', async (request, response, next) => {
    try {
      const tournamentId = routeId(request, 'tournamentId');
      const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { id: true } });
      if (!tournament) throw new HttpError(404, 'TOURNAMENT_NOT_FOUND', 'The tournament was not found.');
      const results = await prisma.tournamentParticipant.findMany({
        where: { tournamentId, status: 'REGISTERED' }, include: { user: { select: { id: true, name: true } } },
        orderBy: [{ points: 'desc' }, { wins: 'desc' }, { user: { name: 'asc' } }, { userId: 'asc' }],
      });
      response.status(200).json(apiSuccess(results.map((item, index) => ({ rank: index + 1, userId: item.userId, playerName: item.user.name, teamName: item.teamName, wins: item.wins, points: item.points }))));
    } catch (error) { next(error); }
  });

  router.get('/leaderboards', async (request, response, next) => {
    const parsed = leaderboardQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const groups = await prisma.tournamentParticipant.groupBy({
        by: ['userId'],
        where: { status: 'REGISTERED', tournament: { status: 'COMPLETED', ...(parsed.data.sportId ? { sportId: parsed.data.sportId } : {}) } },
        _sum: { wins: true, points: true },
      });
      const users = groups.length ? await prisma.user.findMany({ where: { id: { in: groups.map(row => row.userId) } }, select: { id: true, name: true } }) : [];
      const names = new Map(users.map(user => [user.id, user.name]));
      const ordered = groups.map(group => ({ userId: group.userId, playerName: names.get(group.userId) ?? '', wins: group._sum.wins ?? 0, points: group._sum.points ?? 0 }))
        .sort((a, b) => b.points - a.points || b.wins - a.wins || a.playerName.localeCompare(b.playerName) || a.userId.localeCompare(b.userId))
        .slice(0, parsed.data.limit).map((item, index) => ({ rank: index + 1, ...item }));
      response.status(200).json(apiSuccess(ordered));
    } catch (error) { next(error); }
  });

  return router;
}
