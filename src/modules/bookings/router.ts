import { Router, type Request, type Response } from 'express';
import { Prisma, type PrismaClient, type PaymentMethod } from '../../generated/prisma/client.js';
import { apiError, apiSuccess } from '../../common/apiResponse.js';
import { HttpError } from '../../common/httpError.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { bookingCancelSchema, bookingCreateSchema, bookingListQuerySchema, availabilityQuerySchema, walkInCreateSchema } from './schemas.js';
import { bookingDetailsInclude, bookingDto, expirePendingHolds, paisaToPKR, type BookingDetails } from './service.js';
import { buildSlots, localDateTimeToUtc, localDayBounds, timeToMinutes, utcInstantToLocal, weekdayForDate } from './schedule.js';

export interface BookingRouterOptions {
  prisma: PrismaClient;
  accessSecret: string;
  onlineProvider: { provider: 'SAFEPAY' | 'DEVELOPMENT_MOCK'; environment: 'SANDBOX' | 'DEVELOPMENT' };
}

const HOLD_TTL_MS = 15 * 60 * 1000;
const MAX_BOOKING_DAYS_AHEAD = 90;
const OPEN_PAYMENT_STATUSES = ['PENDING', 'PROCESSING', 'DUE_AT_VENUE', 'AWAITING_TRANSFER', 'PROOF_SUBMITTED'] as const;

function invalid(response: Response, issues: { path: PropertyKey[]; message: string }[]): void {
  response.status(400).json(apiError('VALIDATION_ERROR', 'The request is invalid.', issues.map(issue => ({
    field: issue.path.join('.'), message: issue.message,
  }))));
}

function routeId(request: Request, name: string): string {
  const raw = request.params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'INVALID_ID', `The ${name} must be a valid UUID.`);
  }
  return value;
}

function keyFromRequest(request: Request, userId: string): string | undefined {
  const key = request.header('idempotency-key')?.trim();
  if (!key) return undefined;
  if (key.length < 1 || key.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1–80 letters, numbers, dots, underscores, colons or hyphens.');
  }
  return `${userId}:${key}`;
}

function prismaCode(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && typeof candidate === 'object' && candidate !== null; depth += 1) {
    if ('code' in candidate && typeof candidate.code === 'string') return candidate.code;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

function mapBookingError(error: unknown): unknown {
  const code = prismaCode(error);
  const message = error instanceof Error ? error.message : '';
  if (code === '23P01' || (code === 'P2004' && message.includes('bookings_no_active_court_overlap')) || message.includes('bookings_no_active_court_overlap')) {
    return new HttpError(409, 'SLOT_UNAVAILABLE', 'That court time was just booked. Choose another available slot.');
  }
  if (code === 'P2002' && message.includes('idempotency')) {
    return new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for another booking request.');
  }
  return error;
}

function paymentView(payment: {
  id: string; method: PaymentMethod; provider: string; environment: string; status: string;
  amountPaisa: number; currency: string; providerReference?: string | null; checkoutUrl?: string | null;
}) {
  return {
    id: payment.id,
    method: payment.method,
    provider: payment.provider,
    environment: payment.environment,
    status: payment.status,
    amountPaisa: payment.amountPaisa,
    amountPKR: paisaToPKR(payment.amountPaisa),
    currency: payment.currency,
    providerReference: payment.providerReference ?? null,
    ...(payment.checkoutUrl ? { checkoutUrl: payment.checkoutUrl } : {}),
    simulation: payment.provider === 'DEVELOPMENT_MOCK',
  };
}

function maxDateKey(todayKey: string, days: number): string {
  const date = new Date(`${todayKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function dayNameMatches(availableDays: string[], weekday: string): boolean {
  return availableDays.some(day => day.trim().slice(0, 3).toLowerCase() === weekday.toLowerCase());
}

async function reserveEquipment(tx: Prisma.TransactionClient, input: {
  venueId: string; startsAt: Date; endsAt: Date; equipmentIds: string[];
  selections: Array<{ equipmentId: string; quantity: number }>; now: Date;
}) {
  if (!input.equipmentIds.length) return [];
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "equipment_items"
    WHERE "id" IN (${Prisma.join(input.equipmentIds)})
    ORDER BY "id"
    FOR UPDATE
  `);
  const items = await tx.equipmentItem.findMany({
    where: { id: { in: input.equipmentIds }, venueId: input.venueId, active: true },
    select: { id: true, name: true, priceMode: true, unitPricePaisa: true, quantityAvailable: true },
  });
  if (items.length !== input.equipmentIds.length) {
    throw new HttpError(400, 'ADDON_UNAVAILABLE', 'An add-on is no longer available at this venue.');
  }

  const reserved = await tx.$queryRaw<Array<{ equipmentItemId: string; reservedQuantity: bigint | number | null }>>(Prisma.sql`
    SELECT bi."equipment_item_id" AS "equipmentItemId",
      COALESCE(SUM(bi."quantity"), 0)::bigint AS "reservedQuantity"
    FROM "booking_items" bi
    INNER JOIN "bookings" b ON b."id" = bi."booking_id"
    WHERE bi."equipment_item_id" IN (${Prisma.join(input.equipmentIds)})
      AND (b."status" IN ('CONFIRMED', 'COMPLETED')
        OR (b."status" = 'PENDING_PAYMENT' AND b."hold_expires_at" > ${input.now}))
      AND (
        (bi."price_mode_snapshot" = 'SALE')
        OR (bi."price_mode_snapshot" = 'RENTAL' AND b."starts_at" < ${input.endsAt} AND b."ends_at" > ${input.startsAt})
      )
    GROUP BY bi."equipment_item_id"
  `);
  const reservedById = new Map(reserved.map(item => [item.equipmentItemId, Number(item.reservedQuantity ?? 0)]));
  const itemById = new Map(items.map(item => [item.id, item]));
  return input.selections.map(selection => {
    const item = itemById.get(selection.equipmentId)!;
    const totalReserved = reservedById.get(item.id) ?? 0;
    if (totalReserved + selection.quantity > item.quantityAvailable) {
      throw new HttpError(409, 'ADDON_STOCK_UNAVAILABLE', `${item.name} is no longer available in that quantity.`);
    }
    const lineTotalPaisa = item.unitPricePaisa * selection.quantity;
    if (!Number.isSafeInteger(lineTotalPaisa)) throw new HttpError(400, 'INVALID_PRICE', 'The add-on price is outside the supported range.');
    return {
      equipmentItemId: item.id,
      nameSnapshot: item.name,
      priceModeSnapshot: item.priceMode,
      unitPricePaisa: item.unitPricePaisa,
      quantity: selection.quantity,
      lineTotalPaisa,
    };
  });
}

export function createBookingRouter({ prisma, accessSecret, onlineProvider }: BookingRouterOptions): Router {
  const router = Router();
  const authenticate = requireAuth(prisma, accessSecret);
  const playerOnly = requireRole('PLAYER');
  const vendorOnly = requireRole('VENDOR');

  router.get('/courts/:courtId/availability', authenticate, async (request, response, next) => {
    const parsed = availabilityQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      await expirePendingHolds(prisma);
      const courtId = routeId(request, 'courtId');
      const court = await prisma.court.findFirst({
        where: { id: courtId, isActive: true, venue: {
          deletedAt: null,
          OR: [
            { published: true },
            { vendorProfile: { ownerUserId: request.auth!.userId } },
          ],
        } },
        select: {
          id: true, name: true, slotDurationMinutes: true, openingTime: true, closingTime: true,
          availableDays: true, venue: { select: { id: true, name: true, timeZone: true } },
        },
      });
      if (!court) throw new HttpError(404, 'COURT_NOT_FOUND', 'The court was not found.');
      const { date } = parsed.data;
      const bounds = localDayBounds(date, court.venue.timeZone);
      if (!bounds) throw new HttpError(400, 'INVALID_DATE_OR_TIME_ZONE', 'The date or venue timezone is invalid.');
      const today = utcInstantToLocal(new Date(), court.venue.timeZone)?.date;
      if (today && date > maxDateKey(today, MAX_BOOKING_DAYS_AHEAD)) {
        throw new HttpError(400, 'DATE_TOO_FAR_AHEAD', `Availability can be requested up to ${MAX_BOOKING_DAYS_AHEAD} days ahead.`);
      }
      const weekday = weekdayForDate(date);
      const isOpen = Boolean(weekday && dayNameMatches(court.availableDays, weekday));
      const [blocks, bookings] = await Promise.all([
        prisma.courtBlock.findMany({
          where: { courtId, startsAt: { lt: bounds.endsAt }, endsAt: { gt: bounds.startsAt } },
          select: { startsAt: true, endsAt: true },
        }),
        prisma.booking.findMany({
          where: {
            courtId, status: { in: ['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED'] },
            startsAt: { lt: bounds.endsAt }, endsAt: { gt: bounds.startsAt },
          },
          select: { startsAt: true, endsAt: true, status: true, holdExpiresAt: true },
        }),
      ]);
      const slots = isOpen ? buildSlots({
        date, timeZone: court.venue.timeZone, openingTime: court.openingTime, closingTime: court.closingTime,
        slotDurationMinutes: court.slotDurationMinutes, availableDays: court.availableDays, now: new Date(), blocks, bookings,
      }) : [];
      response.status(200).json(apiSuccess({
        courtId: court.id, groundId: court.id, courtName: court.name, venueId: court.venue.id,
        venueName: court.venue.name, date, timeZone: court.venue.timeZone, isOpen,
        slots: slots.map(slot => ({
          date: slot.date, startTime: slot.startTime, endTime: slot.endTime,
          startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(),
          available: slot.available, status: slot.available ? 'AVAILABLE' : 'UNAVAILABLE', reason: slot.reason,
        })),
      }));
    } catch (error) { next(error); }
  });

  router.post('/bookings', authenticate, playerOnly, async (request, response, next) => {
    const parsed = bookingCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const userId = request.auth!.userId;
      const idempotencyKey = keyFromRequest(request, userId);
      if (idempotencyKey) {
        const existing = await prisma.booking.findUnique({ where: { idempotencyKey }, include: bookingDetailsInclude });
        if (existing) {
          response.status(200).json(apiSuccess({ booking: bookingDto(existing), replayed: true }));
          return;
        }
      }
      await expirePendingHolds(prisma);
      const input = parsed.data;
      const now = new Date();
      const result = await prisma.$transaction(async tx => {
        const court = await tx.court.findFirst({
          where: { id: input.courtId, isActive: true, venue: { deletedAt: null, published: true } },
          select: {
            id: true, venueId: true, name: true, openingTime: true, closingTime: true, availableDays: true,
            slotDurationMinutes: true, hourlyPricePaisa: true,
            venue: { select: { timeZone: true } },
          },
        });
        if (!court) throw new HttpError(404, 'COURT_NOT_FOUND', 'The court was not found.');

        const startMinute = timeToMinutes(input.startTime);
        const endMinute = timeToMinutes(input.endTime);
        const opening = timeToMinutes(court.openingTime);
        const closing = timeToMinutes(court.closingTime);
        const weekday = weekdayForDate(input.date);
        if (startMinute === undefined || endMinute === undefined || opening === undefined || closing === undefined
          || !weekday || !dayNameMatches(court.availableDays, weekday)
          || startMinute < opening || endMinute > closing || endMinute <= startMinute
          || (startMinute - opening) % court.slotDurationMinutes !== 0
          || (endMinute - startMinute) % court.slotDurationMinutes !== 0) {
          throw new HttpError(409, 'SLOT_CLOSED', 'The selected time does not fit this court’s opening hours or slot schedule.');
        }
        const start = localDateTimeToUtc(input.date, input.startTime, court.venue.timeZone);
        const end = localDateTimeToUtc(input.date, input.endTime, court.venue.timeZone);
        if (!start || !end) throw new HttpError(400, 'INVALID_LOCAL_TIME', 'The selected local time does not exist in the venue timezone.');
        if (start <= now) throw new HttpError(409, 'SLOT_IN_PAST', 'The selected court time has already started.');

        const block = await tx.courtBlock.findFirst({
          where: { courtId: court.id, startsAt: { lt: end }, endsAt: { gt: start } }, select: { id: true },
        });
        if (block) throw new HttpError(409, 'SLOT_BLOCKED', 'The selected court time is blocked by the venue.');
        const conflict = await tx.booking.findFirst({
          where: {
            courtId: court.id,
            startsAt: { lt: end }, endsAt: { gt: start },
            OR: [
              { status: { in: ['CONFIRMED', 'COMPLETED'] } },
              { status: 'PENDING_PAYMENT', holdExpiresAt: { gt: now } },
            ],
          }, select: { id: true },
        });
        if (conflict) throw new HttpError(409, 'SLOT_UNAVAILABLE', 'That court time is no longer available.');

        const participantUserIds = [...new Set([userId, ...input.participantUserIds])];
        const participants = await tx.user.findMany({
          where: { id: { in: participantUserIds }, role: 'PLAYER', status: 'ACTIVE' }, select: { id: true, name: true },
        });
        if (participants.length !== participantUserIds.length) {
          throw new HttpError(400, 'INVALID_PARTICIPANT', 'Every booking participant must be an active player account.');
        }

        const lines = await reserveEquipment(tx, {
          venueId: court.venueId, startsAt: start, endsAt: end,
          equipmentIds: input.addOns.map(item => item.equipmentId), selections: input.addOns, now,
        });
        const durationMinutes = endMinute - startMinute;
        const groundFeePaisa = Math.round(court.hourlyPricePaisa * durationMinutes / 60);
        const addOnsTotalPaisa = lines.reduce((sum, item) => sum + item.lineTotalPaisa, 0);
        const totalPaisa = groundFeePaisa + addOnsTotalPaisa;
        if (![groundFeePaisa, addOnsTotalPaisa, totalPaisa].every(Number.isSafeInteger)) {
          throw new HttpError(400, 'INVALID_PRICE', 'The selected booking total is outside the supported range.');
        }
        const shareBase = Math.floor(totalPaisa / participants.length);
        const shareRemainder = totalPaisa % participants.length;
        const holdExpiresAt = input.paymentMode === 'PAY_AT_VENUE' || totalPaisa === 0 ? null : new Date(now.getTime() + HOLD_TTL_MS);
        const bookingStatus = input.paymentMode === 'PAY_AT_VENUE' || totalPaisa === 0 ? 'CONFIRMED' as const : 'PENDING_PAYMENT' as const;
        const bookingPaymentStatus = totalPaisa === 0 ? 'PAID' as const
          : input.paymentMode === 'PAY_AT_VENUE' ? 'DUE_AT_VENUE' as const : 'PENDING' as const;
        const created = await tx.booking.create({
          data: {
            venueId: court.venueId, courtId: court.id, customerUserId: userId, createdByUserId: userId,
            source: 'APP', status: bookingStatus, paymentMode: input.paymentMode, paymentStatus: bookingPaymentStatus,
            startsAt: start, endsAt: end, timeZone: court.venue.timeZone, groundFeePaisa, addOnsTotalPaisa,
            totalPaisa, currency: 'PKR', idempotencyKey: idempotencyKey ?? null, holdExpiresAt,
            items: { create: lines },
            participants: { create: participants.map((participant, index) => {
              const sharePaisa = shareBase + (index < shareRemainder ? 1 : 0);
              return {
                userId: participant.id, isOrganizer: participant.id === userId, sharePaisa,
                paymentStatus: totalPaisa === 0 ? 'PAID' : input.paymentMode === 'PAY_AT_VENUE' ? 'UNPAID' : 'PENDING',
                contribution: { create: {
                  amountDuePaisa: sharePaisa, amountPaidPaisa: 0,
                  status: totalPaisa === 0 ? 'PAID' : input.paymentMode === 'PAY_AT_VENUE' ? 'UNPAID' : 'PENDING',
                } },
              };
            }) },
          },
          include: bookingDetailsInclude,
        }) as unknown as BookingDetails;

        let payment;
        if (totalPaisa > 0) {
          const method = input.paymentMode as PaymentMethod;
          const provider = method === 'ONLINE' ? onlineProvider.provider : 'MANUAL';
          const environment = method === 'ONLINE' ? onlineProvider.environment : 'MANUAL';
          const status = method === 'ONLINE' ? 'PENDING' as const
            : method === 'PAY_AT_VENUE' ? 'DUE_AT_VENUE' as const : 'AWAITING_TRANSFER' as const;
          for (const participant of created.participants) {
            const contribution = participant.contribution;
            if (!contribution) throw new HttpError(500, 'CONTRIBUTION_CREATE_FAILED', 'A booking contribution could not be created.');
            const participantPayment = await tx.payment.create({ data: {
              userId: participant.userId, provider, method, environment, purpose: 'BOOKING_CONTRIBUTION', status,
              amountPaisa: contribution.amountDuePaisa, currency: 'PKR', contributionId: contribution.id,
              idempotencyKey: `booking:${created.id}:contribution:${contribution.id}:initial`,
            } });
            if (participant.userId === userId) payment = participantPayment;
            if (method !== 'ONLINE') {
              await tx.paymentStatusAudit.create({ data: {
                paymentId: participantPayment.id, actorUserId: userId, previousStatus: null, newStatus: status,
                amountPaisa: participantPayment.amountPaisa, reason: method === 'PAY_AT_VENUE' ? 'PAY_AT_VENUE_SELECTED' : 'BANK_TRANSFER_SELECTED',
              } });
            }
          }
        }
        return { booking: created, payment };
      });
      response.status(201).json(apiSuccess({
        booking: bookingDto(result.booking),
        payment: result.payment ? paymentView(result.payment) : null,
      }));
    } catch (error) { next(mapBookingError(error)); }
  });

  router.post('/vendors/me/bookings/walk-in', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = walkInCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const userId = request.auth!.userId;
      const idempotencyKey = keyFromRequest(request, userId);
      if (idempotencyKey) {
        const existing = await prisma.booking.findUnique({ where: { idempotencyKey }, include: bookingDetailsInclude });
        if (existing) {
          if (existing.createdByUserId !== userId || existing.source !== 'WALK_IN') {
            throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for another booking request.');
          }
          response.status(200).json(apiSuccess({ booking: bookingDto(existing), replayed: true }));
          return;
        }
      }
      await expirePendingHolds(prisma);
      const input = parsed.data;
      const now = new Date();
      const result = await prisma.$transaction(async tx => {
        const court = await tx.court.findFirst({
          where: { id: input.courtId, isActive: true, venue: { deletedAt: null, vendorProfile: { ownerUserId: userId } } },
          select: {
            id: true, venueId: true, name: true, openingTime: true, closingTime: true, availableDays: true,
            slotDurationMinutes: true, hourlyPricePaisa: true, venue: { select: { timeZone: true } },
          },
        });
        if (!court) throw new HttpError(404, 'COURT_NOT_FOUND', 'The court was not found.');
        const startMinute = timeToMinutes(input.startTime);
        const endMinute = timeToMinutes(input.endTime);
        const opening = timeToMinutes(court.openingTime);
        const closing = timeToMinutes(court.closingTime);
        const weekday = weekdayForDate(input.date);
        if (startMinute === undefined || endMinute === undefined || opening === undefined || closing === undefined
          || !weekday || !dayNameMatches(court.availableDays, weekday)
          || startMinute < opening || endMinute > closing || endMinute <= startMinute
          || (startMinute - opening) % court.slotDurationMinutes !== 0
          || (endMinute - startMinute) % court.slotDurationMinutes !== 0) {
          throw new HttpError(409, 'SLOT_CLOSED', 'The selected time does not fit this court’s opening hours or slot schedule.');
        }
        const start = localDateTimeToUtc(input.date, input.startTime, court.venue.timeZone);
        const end = localDateTimeToUtc(input.date, input.endTime, court.venue.timeZone);
        if (!start || !end) throw new HttpError(400, 'INVALID_LOCAL_TIME', 'The selected local time does not exist in the venue timezone.');
        if (start <= now) throw new HttpError(409, 'SLOT_IN_PAST', 'The selected court time has already started.');
        const block = await tx.courtBlock.findFirst({ where: { courtId: court.id, startsAt: { lt: end }, endsAt: { gt: start } }, select: { id: true } });
        if (block) throw new HttpError(409, 'SLOT_BLOCKED', 'The selected court time is blocked by the venue.');
        const conflict = await tx.booking.findFirst({
          where: {
            courtId: court.id, startsAt: { lt: end }, endsAt: { gt: start },
            OR: [
              { status: { in: ['CONFIRMED', 'COMPLETED'] } },
              { status: 'PENDING_PAYMENT', holdExpiresAt: { gt: now } },
            ],
          }, select: { id: true },
        });
        if (conflict) throw new HttpError(409, 'SLOT_UNAVAILABLE', 'That court time is no longer available.');
        const lines = await reserveEquipment(tx, {
          venueId: court.venueId, startsAt: start, endsAt: end,
          equipmentIds: input.addOns.map(item => item.equipmentId), selections: input.addOns, now,
        });
        const durationMinutes = endMinute - startMinute;
        const groundFeePaisa = Math.round(court.hourlyPricePaisa * durationMinutes / 60);
        const addOnsTotalPaisa = lines.reduce((sum, item) => sum + item.lineTotalPaisa, 0);
        const totalPaisa = groundFeePaisa + addOnsTotalPaisa;
        if (![groundFeePaisa, addOnsTotalPaisa, totalPaisa].every(Number.isSafeInteger)) {
          throw new HttpError(400, 'INVALID_PRICE', 'The selected booking total is outside the supported range.');
        }
        const created = await tx.booking.create({
          data: {
            venueId: court.venueId, courtId: court.id, createdByUserId: userId,
            source: 'WALK_IN', status: 'CONFIRMED', paymentMode: 'PAY_AT_VENUE', paymentStatus: totalPaisa === 0 ? 'PAID' : 'DUE_AT_VENUE',
            startsAt: start, endsAt: end, timeZone: court.venue.timeZone,
            customerName: input.customerName, customerPhone: input.customerPhone || null,
            groundFeePaisa, addOnsTotalPaisa, totalPaisa, currency: 'PKR', idempotencyKey: idempotencyKey ?? null, holdExpiresAt: null,
            items: { create: lines },
          }, include: bookingDetailsInclude,
        }) as unknown as BookingDetails;
        const payment = totalPaisa > 0 ? await tx.payment.create({ data: {
          userId: null, provider: 'MANUAL', method: 'PAY_AT_VENUE', environment: 'MANUAL', purpose: 'WALK_IN_BOOKING',
          status: 'DUE_AT_VENUE', amountPaisa: totalPaisa, currency: 'PKR', bookingId: created.id,
          idempotencyKey: `walk-in:${created.id}:cash`,
        } }) : null;
        if (payment) await tx.paymentStatusAudit.create({ data: {
          paymentId: payment.id, actorUserId: userId, previousStatus: null, newStatus: 'DUE_AT_VENUE',
          amountPaisa: totalPaisa, reason: 'WALK_IN_PAYMENT_DUE_AT_VENUE',
        } });
        return { booking: created, payment };
      });
      response.status(201).json(apiSuccess({
        booking: bookingDto(result.booking), payment: result.payment ? paymentView(result.payment) : null,
      }));
    } catch (error) { next(mapBookingError(error)); }
  });

  router.get('/bookings/me', authenticate, playerOnly, async (request, response, next) => {
    const parsed = bookingListQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      await expirePendingHolds(prisma);
      const query = parsed.data;
      const where: Prisma.BookingWhereInput = {
        OR: [
          { customerUserId: request.auth!.userId },
          { participants: { some: { userId: request.auth!.userId } } },
        ],
        ...(query.courtId ? { courtId: query.courtId } : {}),
        ...(query.status ? { status: query.status } : {}),
      };
      if (query.from || query.to) {
        const start = query.from ? localDayBounds(query.from, 'Asia/Karachi')?.startsAt : undefined;
        const end = query.to ? localDayBounds(query.to, 'Asia/Karachi')?.endsAt : undefined;
        where.startsAt = { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) };
      }
      const [bookings, total] = await Promise.all([
        prisma.booking.findMany({ where, include: bookingDetailsInclude, orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }], skip: (query.page - 1) * query.limit, take: query.limit }),
        prisma.booking.count({ where }),
      ]);
      response.status(200).json(apiSuccess(bookings.map(bookingDto), { page: query.page, limit: query.limit, total }));
    } catch (error) { next(error); }
  });

  router.get('/vendors/me/bookings', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = bookingListQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      await expirePendingHolds(prisma);
      const query = parsed.data;
      const vendorProfile = await prisma.vendorProfile.findUnique({ where: { ownerUserId: request.auth!.userId }, select: { id: true } });
      if (!vendorProfile) throw new HttpError(404, 'VENDOR_PROFILE_NOT_FOUND', 'The vendor profile was not found.');
      const where: Prisma.BookingWhereInput = {
        venue: { vendorProfileId: vendorProfile.id },
        ...(query.courtId ? { courtId: query.courtId } : {}),
        ...(query.status ? { status: query.status } : {}),
      };
      if (query.from || query.to) {
        const start = query.from ? localDayBounds(query.from, 'Asia/Karachi')?.startsAt : undefined;
        const end = query.to ? localDayBounds(query.to, 'Asia/Karachi')?.endsAt : undefined;
        where.startsAt = { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) };
      }
      const [bookings, total] = await Promise.all([
        prisma.booking.findMany({ where, include: bookingDetailsInclude, orderBy: [{ startsAt: 'asc' }, { createdAt: 'asc' }], skip: (query.page - 1) * query.limit, take: query.limit }),
        prisma.booking.count({ where }),
      ]);
      response.status(200).json(apiSuccess(bookings.map(bookingDto), { page: query.page, limit: query.limit, total }));
    } catch (error) { next(error); }
  });

  router.get('/bookings/:bookingId', authenticate, async (request, response, next) => {
    try {
      await expirePendingHolds(prisma);
      const bookingId = routeId(request, 'bookingId');
      const booking = await prisma.booking.findFirst({
        where: {
          id: bookingId,
          OR: [
            { customerUserId: request.auth!.userId },
            { participants: { some: { userId: request.auth!.userId } } },
            { venue: { vendorProfile: { ownerUserId: request.auth!.userId } } },
          ],
        }, include: bookingDetailsInclude,
      });
      if (!booking) throw new HttpError(404, 'BOOKING_NOT_FOUND', 'The booking was not found.');
      response.status(200).json(apiSuccess(bookingDto(booking)));
    } catch (error) { next(error); }
  });

  router.post('/bookings/:bookingId/cancel', authenticate, async (request, response, next) => {
    const parsed = bookingCancelSchema.safeParse(request.body ?? {});
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const bookingId = routeId(request, 'bookingId');
      const now = new Date();
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "bookings" WHERE "id" = ${bookingId}::uuid FOR UPDATE`);
        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
          include: { participants: { include: { contribution: true } } },
        });
        if (!booking) throw new HttpError(404, 'BOOKING_NOT_FOUND', 'The booking was not found.');
        const isPlayerParticipant = booking.customerUserId === request.auth!.userId
          || booking.participants.some(participant => participant.userId === request.auth!.userId);
        const isVendorOwner = request.auth!.role === 'VENDOR'
          && (await tx.venue.findFirst({ where: { id: booking.venueId, vendorProfile: { ownerUserId: request.auth!.userId } }, select: { id: true } })) !== null;
        if (!isPlayerParticipant && !isVendorOwner) throw new HttpError(404, 'BOOKING_NOT_FOUND', 'The booking was not found.');
        if (!['PENDING_PAYMENT', 'CONFIRMED'].includes(booking.status) || booking.startsAt <= now) {
          throw new HttpError(409, 'BOOKING_CANNOT_BE_CANCELLED', 'This booking can no longer be cancelled.');
        }
        const payments = await tx.payment.findMany({
          where: {
            OR: [
              { bookingId },
              { contribution: { bookingParticipant: { bookingId } } },
            ],
          }, select: { id: true, status: true, amountPaisa: true },
        });
        const settled = payments.filter(payment => payment.status === 'SUCCEEDED');
        const openOrDue = payments.filter(payment => OPEN_PAYMENT_STATUSES.includes(payment.status as typeof OPEN_PAYMENT_STATUSES[number]));
        if (openOrDue.length) {
          await tx.payment.updateMany({ where: { id: { in: openOrDue.map(payment => payment.id) } }, data: { status: 'CANCELLED' } });
          await tx.paymentStatusAudit.createMany({ data: openOrDue.map(payment => ({
            paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: payment.status,
            newStatus: 'CANCELLED' as const, amountPaisa: payment.amountPaisa,
            reason: parsed.data.reason || 'BOOKING_CANCELLED',
          })) });
        }
        if (settled.length) {
          await tx.payment.updateMany({ where: { id: { in: settled.map(payment => payment.id) } }, data: { status: 'REFUND_PENDING' } });
          await tx.paymentStatusAudit.createMany({ data: settled.map(payment => ({
            paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: 'SUCCEEDED' as const,
            newStatus: 'REFUND_PENDING' as const, amountPaisa: payment.amountPaisa,
            reason: parsed.data.reason || 'BOOKING_CANCELLED_REFUND_REQUIRED',
          })) });
        }
        await tx.paymentContribution.updateMany({
          where: { bookingParticipant: { bookingId }, amountPaidPaisa: { gt: 0 } }, data: { status: 'REFUND_PENDING' },
        });
        await tx.paymentContribution.updateMany({
          where: { bookingParticipant: { bookingId }, amountPaidPaisa: 0 }, data: { status: 'FAILED' },
        });
        const updated = await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: 'CANCELLED', paymentStatus: settled.length ? 'REFUND_PENDING' : 'FAILED',
            cancelledAt: now, holdExpiresAt: null,
          }, include: bookingDetailsInclude,
        });
        return updated;
      });
      response.status(200).json(apiSuccess({ booking: bookingDto(result), refundStatus: result.paymentStatus === 'REFUND_PENDING' ? 'REFUND_PENDING' : 'NOT_APPLICABLE' }));
    } catch (error) { next(error); }
  });

  router.post('/vendors/me/bookings/:bookingId/complete', authenticate, vendorOnly, async (request, response, next) => {
    try {
      const bookingId = routeId(request, 'bookingId');
      const vendorProfile = await prisma.vendorProfile.findUnique({ where: { ownerUserId: request.auth!.userId }, select: { id: true } });
      if (!vendorProfile) throw new HttpError(404, 'VENDOR_PROFILE_NOT_FOUND', 'The vendor profile was not found.');
      const booking = await prisma.booking.findFirst({
        where: { id: bookingId, venue: { vendorProfileId: vendorProfile.id } }, include: bookingDetailsInclude,
      });
      if (!booking) throw new HttpError(404, 'BOOKING_NOT_FOUND', 'The booking was not found.');
      if (booking.status === 'COMPLETED') {
        response.status(200).json(apiSuccess({ booking: bookingDto(booking) }));
        return;
      }
      if (booking.status !== 'CONFIRMED' || booking.endsAt > new Date()) {
        throw new HttpError(409, 'BOOKING_CANNOT_BE_COMPLETED', 'Only a confirmed booking whose court time has ended can be completed.');
      }
      const completed = await prisma.booking.update({ where: { id: booking.id }, data: { status: 'COMPLETED', holdExpiresAt: null }, include: bookingDetailsInclude });
      response.status(200).json(apiSuccess({ booking: bookingDto(completed) }));
    } catch (error) { next(error); }
  });

  return router;
}
