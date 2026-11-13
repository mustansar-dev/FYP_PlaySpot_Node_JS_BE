import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { apiError, apiSuccess } from '../../common/apiResponse.js';
import { HttpError } from '../../common/httpError.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import { sendMessage } from './chatService.js';
import {
  leaderboardQuerySchema, messageCreateSchema, messageListQuerySchema, roomCreateSchema, roomJoinSchema,
  roomListQuerySchema, roomMemberParamSchema, standingsSchema, tournamentCreateSchema,
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

function roomDto(room: {
  id: string; title: string; locationLabel: string; startsAt: Date; endsAt: Date; timeZone: string;
  visibility: string; capacity: number; totalCostPaisa: number; perPlayerSharePaisa: number; paymentMode: string;
  status: string; createdAt: Date; organizerUserId: string; sport: { id: string; name: string; code: string };
  venue: { id: string; name: string; city: string } | null; court: { id: string; name: string } | null;
  members: Array<{ userId: string; role: string; seatIndex: number; user: { id: string; name: string } }>;
}) {
  return {
    id: room.id, title: room.title, locationLabel: room.locationLabel,
    startsAt: room.startsAt.toISOString(), endsAt: room.endsAt.toISOString(), timeZone: room.timeZone,
    visibility: room.visibility, capacity: room.capacity, memberCount: room.members.length,
    totalCostPaisa: room.totalCostPaisa, perPlayerSharePaisa: room.perPlayerSharePaisa,
    paymentMode: room.paymentMode, status: room.status, organizerUserId: room.organizerUserId,
    sport: room.sport, venue: room.venue, court: room.court,
    members: room.members.map(member => ({ userId: member.userId, name: member.user.name, role: member.role, seatIndex: member.seatIndex })),
    createdAt: room.createdAt.toISOString(),
  };
}

const roomInclude = {
  sport: { select: { id: true, name: true, code: true } },
  venue: { select: { id: true, name: true, city: true } },
  court: { select: { id: true, name: true } },
  members: { include: { user: { select: { id: true, name: true } } }, orderBy: { seatIndex: 'asc' as const } },
} satisfies Prisma.GameRoomInclude;

export function createCommunityRouter({ prisma, accessSecret, realtime }: CommunityRouterOptions): Router {
  const router = Router();
  const authenticate = requireAuth(prisma, accessSecret);
  const playerOnly = requireRole('PLAYER');
  const vendorOnly = requireRole('VENDOR');

  router.post('/game-rooms', authenticate, playerOnly, async (request, response, next) => {
    const parsed = roomCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const input = parsed.data;
      const sport = await prisma.sport.findFirst({ where: { id: input.sportId, isActive: true }, select: { id: true } });
      if (!sport) throw new HttpError(400, 'INVALID_SPORT', 'The selected sport is unavailable.');
      if (input.venueId) {
        const venue = await prisma.venue.findFirst({ where: { id: input.venueId, deletedAt: null, published: true }, select: { id: true } });
        if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
      }
      let totalCostPaisa = 0;
      if (input.courtId) {
        const court = await prisma.court.findFirst({ where: { id: input.courtId, venueId: input.venueId!, isActive: true }, select: { id: true, hourlyPricePaisa: true, slotDurationMinutes: true } });
        if (!court) throw new HttpError(404, 'COURT_NOT_FOUND', 'The court was not found at this venue.');
        const duration = (input.endsAt.getTime() - input.startsAt.getTime()) / 60_000;
        if (duration % court.slotDurationMinutes !== 0) throw new HttpError(400, 'INVALID_ROOM_DURATION', 'The room duration must align with the selected court slot length.');
        totalCostPaisa = Math.round(court.hourlyPricePaisa * duration / 60);
      }
      const inviteCode = input.visibility === 'PRIVATE' ? randomBytes(32).toString('base64url') : undefined;
      const created = await prisma.gameRoom.create({
        data: {
          organizerUserId: request.auth!.userId, sportId: input.sportId, venueId: input.venueId ?? null,
          courtId: input.courtId ?? null, title: input.title, locationLabel: input.locationLabel,
          startsAt: input.startsAt, endsAt: input.endsAt, visibility: input.visibility,
          inviteCodeHash: inviteCode ? hashInvite(inviteCode).toString('hex') : null,
          capacity: input.capacity, totalCostPaisa,
          perPlayerSharePaisa: Math.floor(totalCostPaisa / input.capacity), paymentMode: input.paymentMode,
          members: { create: { userId: request.auth!.userId, role: 'ORGANIZER', seatIndex: 0 } },
          conversation: { create: {
            kind: 'GAME_ROOM', title: input.title,
            members: { create: { userId: request.auth!.userId } },
          } },
        }, include: roomInclude,
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
        const room = await tx.gameRoom.findUnique({ where: { id: roomId }, select: { id: true, status: true, organizerUserId: true, members: { select: { userId: true } } } });
        if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', 'The room was not found.');
        if (room.organizerUserId === request.auth!.userId) throw new HttpError(409, 'HOST_CANNOT_LEAVE', 'The host must close the room instead of leaving it.');
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
        const room = await tx.gameRoom.findUnique({ where: { id: roomId }, select: { id: true, organizerUserId: true, status: true, capacity: true, members: { select: { userId: true } } } });
        if (!room || room.organizerUserId !== request.auth!.userId) throw new HttpError(404, 'ROOM_NOT_FOUND', 'The room was not found.');
        if (targetUserId === room.organizerUserId) throw new HttpError(409, 'HOST_CANNOT_BE_REMOVED', 'The room host cannot be removed.');
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
      const changed = await prisma.gameRoom.updateMany({ where: { id: roomId, organizerUserId: request.auth!.userId, status: { in: ['OPEN', 'FULL'] } }, data: { status: 'CLOSED' } });
      if (!changed.count) throw new HttpError(404, 'ROOM_NOT_FOUND', 'The room was not found or is already closed.');
      response.status(200).json(apiSuccess({ closed: true }));
    } catch (error) { next(error); }
  });

  router.get('/conversations', authenticate, async (request, response, next) => {
    try {
      const rows = await prisma.conversation.findMany({
        where: { members: { some: { userId: request.auth!.userId } } },
        include: {
          members: { include: { user: { select: { id: true, name: true, role: true } } } },
          messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, include: { sender: { select: { id: true, name: true } } } },
          gameRoom: { select: { id: true, visibility: true, status: true } },
          tournament: { select: { id: true, status: true } },
        }, orderBy: { updatedAt: 'desc' },
      });
      response.status(200).json(apiSuccess(rows.map(row => ({
        id: row.id, kind: row.kind, title: row.title, updatedAt: row.updatedAt.toISOString(),
        members: row.members.map(member => member.user),
        lastMessage: row.messages[0] ? {
          id: row.messages[0].id, body: row.messages[0].body, senderUserId: row.messages[0].senderUserId,
          senderName: row.messages[0].sender.name, createdAt: row.messages[0].createdAt.toISOString(),
        } : null,
        gameRoom: row.gameRoom, tournament: row.tournament,
      }))));
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
      const venue = await prisma.venue.findFirst({ where: { id: input.venueId, deletedAt: null, vendorProfile: { ownerUserId: request.auth!.userId } }, select: { id: true } });
      if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
      const sport = await prisma.sport.findFirst({ where: { id: input.sportId, isActive: true }, select: { id: true } });
      if (!sport) throw new HttpError(400, 'INVALID_SPORT', 'The selected sport is unavailable.');
      const tournament = await prisma.tournament.create({ data: {
        ...input, organizerUserId: request.auth!.userId,
        conversation: { create: { kind: 'TOURNAMENT', title: input.title, members: { create: { userId: request.auth!.userId } } } },
      }, include: { venue: { select: { id: true, name: true, city: true } }, sport: { select: { id: true, name: true, code: true } }, organizer: { select: { id: true, name: true } } } });
      response.status(201).json(apiSuccess({ ...tournament, startsAt: tournament.startsAt.toISOString(), endsAt: tournament.endsAt.toISOString() }));
    } catch (error) { next(error); }
  });

  router.get('/tournaments/:tournamentId', async (request, response, next) => {
    try {
      const tournamentId = routeId(request, 'tournamentId');
      const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId }, include: {
        venue: { select: { id: true, name: true, city: true } }, sport: { select: { id: true, name: true, code: true } }, organizer: { select: { id: true, name: true } },
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
        const existing = await tx.tournamentParticipant.findUnique({ where: { tournamentId_userId: { tournamentId, userId: request.auth!.userId } } });
        if (existing && existing.status !== 'WITHDRAWN') throw new HttpError(409, 'ALREADY_REGISTERED', 'You already have a team registered.');
        const data = {
          teamName: parsed.data.teamName, teamMemberNames: parsed.data.teamMemberNames.slice(0, Math.max(0, tournament.teamSize - 1)),
          entryFeePerPlayerPaisa: tournament.entryFeePerPlayerPaisa,
          totalEntryFeePaisa: tournament.entryFeePerPlayerPaisa * tournament.teamSize,
          status: 'REGISTERED' as const, paymentStatus: 'PENDING' as const,
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
      const participant = await prisma.tournamentParticipant.findUnique({ where: { tournamentId_userId: { tournamentId, userId: request.auth!.userId } } });
      if (!participant || participant.status !== 'REGISTERED') throw new HttpError(404, 'TEAM_NOT_FOUND', 'Your registered team was not found.');
      await prisma.tournamentParticipant.update({ where: { id: participant.id }, data: { status: 'WITHDRAWN' } });
      const conversation = await prisma.conversation.findUnique({ where: { tournamentId }, select: { id: true } });
      if (conversation) await prisma.conversationMember.deleteMany({ where: { conversationId: conversation.id, userId: request.auth!.userId } });
      response.status(200).json(apiSuccess({ withdrawn: true }));
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
      const changed = await prisma.tournament.updateMany({
        where: { id: tournamentId, organizerUserId: request.auth!.userId, status: { in: ['UPCOMING', 'ACTIVE'] } },
        data: { status: 'CANCELLED', registrationOpen: false },
      });
      if (!changed.count) throw new HttpError(404, 'TOURNAMENT_NOT_FOUND', 'The tournament was not found or already ended.');
      response.status(200).json(apiSuccess({ cancelled: true, reason: parsed.data.reason ?? null }));
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
