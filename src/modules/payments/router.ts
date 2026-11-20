import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { Prisma, type PaymentMethod, type PrismaClient } from '../../generated/prisma/client.js';
import { apiError, apiSuccess } from '../../common/apiResponse.js';
import { HttpError } from '../../common/httpError.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { expirePendingHolds } from '../bookings/service.js';
import { PaymentGateway } from '../../integrations/payments/provider.js';
import {
  paymentDetailsInclude, paymentDto, reconcileBookingPaymentState, relatedBooking, transitionPaymentInTransaction,
  relatedTournament, type PaymentDetails,
} from './service.js';
import {
  cashReceiptSchema, contributionCreateSchema, mockPaymentResultSchema, paymentInstructionsSchema,
  receiptConfirmSchema, receiptUploadSchema, rejectTransferSchema, transferListQuerySchema,
} from './schemas.js';
import {
  MAX_RECEIPT_BYTES, UnconfiguredPaymentReceiptStorage, validateReceiptFile,
  type PaymentReceiptStorage,
} from './storage.js';

export interface PaymentRouterOptions {
  prisma: PrismaClient;
  accessSecret: string;
  gateway: PaymentGateway;
  storage?: PaymentReceiptStorage;
  nodeEnv: 'development' | 'test' | 'production';
}

const ACTIVE_PAYMENT_STATUSES = ['PENDING', 'PROCESSING', 'DUE_AT_VENUE', 'AWAITING_TRANSFER', 'PROOF_SUBMITTED'] as const;
const RECEIPT_REVIEW_HOLD_MS = 30 * 60 * 1000;
const MAX_RECEIPT_ATTEMPTS = 3;

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

function prismaCode(error: unknown): string | undefined {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && typeof candidate === 'object' && candidate !== null; depth += 1) {
    if ('code' in candidate && typeof candidate.code === 'string') return candidate.code;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

function mapPaymentError(error: unknown): unknown {
  const code = prismaCode(error);
  if (code === 'P2002') return new HttpError(409, 'PAYMENT_ATTEMPT_EXISTS', 'An active payment attempt already exists for this contribution.');
  if (error instanceof Error && error.message === 'PAYMENT_CONTRIBUTION_OVERPAYMENT') {
    return new HttpError(409, 'CONTRIBUTION_ALREADY_SETTLED', 'This contribution has already been paid.');
  }
  if (error instanceof Error && error.message === 'PAYMENT_STATE_TRANSITION_INVALID') {
    return new HttpError(409, 'PAYMENT_STATE_CONFLICT', 'This payment is no longer in a state that can be changed.');
  }
  if (error instanceof Error && error.message === 'PAYMENT_NOT_FOUND') {
    return new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
  }
  return error;
}

async function loadPayment(prisma: PrismaClient, paymentId: string): Promise<PaymentDetails> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: paymentDetailsInclude });
  if (!payment) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
  return payment;
}

function mayReadPayment(payment: PaymentDetails, userId: string, role: string): boolean {
  if (payment.userId === userId) return true;
  return role === 'VENDOR' && (
    relatedBooking(payment)?.venue.vendorProfile.ownerUserId === userId
    || relatedTournament(payment)?.organizerUserId === userId
  );
}

function tournamentPaymentIsOpen(payment: PaymentDetails, now = new Date()): boolean {
  const participant = payment.tournamentParticipant;
  return Boolean(participant && participant.status === 'REGISTERED'
    && participant.tournament.status === 'UPCOMING' && participant.tournament.startsAt > now);
}

function paymentTargetIsOpen(payment: PaymentDetails, now = new Date()): boolean {
  const booking = relatedBooking(payment);
  if (booking) return ['PENDING_PAYMENT', 'CONFIRMED'].includes(booking.status)
    && (booking.status !== 'PENDING_PAYMENT' || !booking.holdExpiresAt || booking.holdExpiresAt > now);
  return tournamentPaymentIsOpen(payment, now);
}

function paymentViewForCheckout(payment: PaymentDetails, checkoutUrl: string | null, simulation: boolean, message?: string) {
  return {
    payment: paymentDto(payment),
    checkoutUrl,
    provider: payment.provider,
    environment: payment.environment,
    simulation,
    ...(message ? { message } : {}),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseSafepayAmount(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return undefined;
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  const paisa = whole * 100n + fraction;
  return paisa <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paisa) : undefined;
}

async function transitionPayment(prisma: PrismaClient, input: {
  paymentId: string; status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
  actorUserId: string | null; reason: string;
}) {
  return prisma.$transaction(tx => transitionPaymentInTransaction(tx, {
    paymentId: input.paymentId, newStatus: input.status, actorUserId: input.actorUserId, reason: input.reason,
  }));
}

export function createPaymentRouter({
  prisma, accessSecret, gateway, storage = new UnconfiguredPaymentReceiptStorage(), nodeEnv,
}: PaymentRouterOptions): Router {
  const router = Router();
  const authenticate = requireAuth(prisma, accessSecret);
  const playerOnly = requireRole('PLAYER');
  const vendorOnly = requireRole('VENDOR');

  async function requireVendorOwnedPayment(paymentId: string, vendorUserId: string): Promise<PaymentDetails> {
    const payment = await loadPayment(prisma, paymentId);
    if (relatedBooking(payment)?.venue.vendorProfile.ownerUserId !== vendorUserId
      && relatedTournament(payment)?.organizerUserId !== vendorUserId) {
      throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
    }
    return payment;
  }

  async function listOwnedPayments(method: 'BANK_TRANSFER' | 'PAY_AT_VENUE', status: 'PROOF_SUBMITTED' | 'DUE_AT_VENUE', vendorUserId: string, page: number, limit: number) {
    const baseQuery = Prisma.sql`
      FROM "payments" p
      LEFT JOIN "bookings" direct_booking ON direct_booking."id" = p."booking_id"
      LEFT JOIN "payment_contributions" pc ON pc."id" = p."contribution_id"
      LEFT JOIN "booking_participants" bp ON bp."id" = pc."booking_participant_id"
      LEFT JOIN "bookings" participant_booking ON participant_booking."id" = bp."booking_id"
      LEFT JOIN "tournament_participants" tp ON tp."id" = p."tournament_participant_id"
      LEFT JOIN "tournaments" t ON t."id" = tp."tournament_id"
      INNER JOIN "venues" v ON v."id" = COALESCE(direct_booking."venue_id", participant_booking."venue_id", t."venue_id")
      INNER JOIN "vendor_profiles" vp ON vp."id" = v."vendor_profile_id"
      WHERE vp."owner_user_id" = ${vendorUserId}::uuid
        AND p."method" = ${method}::"payment_method"
        AND p."status" = ${status}::"payment_status"
    `;
    const [idRows, countRows] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT p."id" ${baseQuery} ORDER BY p."created_at" DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
      prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT COUNT(*)::bigint AS "total" ${baseQuery}`),
    ]);
    const ids = idRows.map(row => row.id);
    const records = ids.length ? await prisma.payment.findMany({ where: { id: { in: ids } }, include: paymentDetailsInclude }) : [];
    const byId = new Map(records.map(record => [record.id, record]));
    return { payments: ids.map(id => byId.get(id)).filter((payment): payment is PaymentDetails => Boolean(payment)), total: Number(countRows[0]?.total ?? 0n) };
  }

  router.post('/bookings/:bookingId/contributions', authenticate, playerOnly, async (request, response, next) => {
    const parsed = contributionCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const bookingId = routeId(request, 'bookingId');
      await expirePendingHolds(prisma);
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT pc."id" FROM "payment_contributions" pc
          INNER JOIN "booking_participants" bp ON bp."id" = pc."booking_participant_id"
          WHERE bp."booking_id" = ${bookingId}::uuid AND bp."user_id" = ${request.auth!.userId}::uuid
          FOR UPDATE OF pc
        `);
        const participant = await tx.bookingParticipant.findUnique({
          where: { bookingId_userId: { bookingId, userId: request.auth!.userId } },
          include: { booking: true, contribution: true },
        });
        if (!participant?.contribution) throw new HttpError(404, 'CONTRIBUTION_NOT_FOUND', 'The booking contribution was not found.');
        if (!['PENDING_PAYMENT', 'CONFIRMED'].includes(participant.booking.status)) {
          throw new HttpError(409, 'BOOKING_NOT_PAYABLE', 'This booking is no longer accepting contributions.');
        }
        if (participant.booking.status === 'PENDING_PAYMENT'
          && (!participant.booking.holdExpiresAt || participant.booking.holdExpiresAt <= new Date())) {
          throw new HttpError(409, 'BOOKING_HOLD_EXPIRED', 'The booking hold has expired. Select an available time again.');
        }
        const existing = await tx.payment.findFirst({
          where: { contributionId: participant.contribution.id, status: { in: [...ACTIVE_PAYMENT_STATUSES] } },
          orderBy: { createdAt: 'desc' }, include: paymentDetailsInclude,
        });
        if (existing) {
          if (existing.method !== parsed.data.method) {
            throw new HttpError(409, 'PAYMENT_METHOD_LOCKED', 'An active payment attempt already exists for this contribution.');
          }
          return { payment: existing, created: false };
        }
        const amountPaisa = participant.contribution.amountDuePaisa - participant.contribution.amountPaidPaisa;
        if (amountPaisa <= 0) throw new HttpError(409, 'CONTRIBUTION_ALREADY_SETTLED', 'This contribution has already been paid.');
        const method = parsed.data.method as PaymentMethod;
        const status = method === 'ONLINE' ? 'PENDING' as const
          : method === 'PAY_AT_VENUE' ? 'DUE_AT_VENUE' as const : 'AWAITING_TRANSFER' as const;
        const payment = await tx.payment.create({ data: {
          userId: request.auth!.userId,
          provider: method === 'ONLINE' ? gateway.provider : 'MANUAL',
          method,
          environment: method === 'ONLINE' ? gateway.environment : 'MANUAL',
          purpose: 'BOOKING_CONTRIBUTION', status, amountPaisa, currency: 'PKR',
          contributionId: participant.contribution.id,
          idempotencyKey: `contribution:${participant.contribution.id}:${randomUUID()}`,
        } });
        if (method !== 'ONLINE') {
          await tx.paymentStatusAudit.create({ data: {
            paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: null, newStatus: status,
            amountPaisa, reason: method === 'PAY_AT_VENUE' ? 'PAY_AT_VENUE_SELECTED' : 'BANK_TRANSFER_SELECTED',
          } });
        }
        await tx.paymentContribution.update({ where: { id: participant.contribution.id }, data: { status: 'PENDING' } });
        await tx.bookingParticipant.update({ where: { id: participant.id }, data: { paymentStatus: 'PENDING' } });
        await reconcileBookingPaymentState(tx, bookingId);
        const detailed = await tx.payment.findUnique({ where: { id: payment.id }, include: paymentDetailsInclude });
        if (!detailed) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
        return { payment: detailed, created: true };
      });
      response.status(result.created ? 201 : 200).json(apiSuccess({ payment: paymentDto(result.payment) }));
    } catch (error) { next(mapPaymentError(error)); }
  });

  router.post('/tournaments/:tournamentId/teams/me/payments', authenticate, playerOnly, async (request, response, next) => {
    const parsed = contributionCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const tournamentId = routeId(request, 'tournamentId');
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "tournaments" WHERE "id" = ${tournamentId}::uuid FOR UPDATE`);
        const participant = await tx.tournamentParticipant.findUnique({
          where: { tournamentId_userId: { tournamentId, userId: request.auth!.userId } },
          include: { tournament: true },
        });
        if (!participant || participant.status !== 'REGISTERED') throw new HttpError(404, 'TEAM_NOT_FOUND', 'Your registered team was not found.');
        if (participant.tournament.status !== 'UPCOMING' || participant.tournament.startsAt <= new Date()) {
          throw new HttpError(409, 'TOURNAMENT_NOT_PAYABLE', 'This tournament is no longer accepting entry payments.');
        }
        if (participant.paymentStatus === 'PAID') throw new HttpError(409, 'TOURNAMENT_ENTRY_ALREADY_PAID', 'This team entry has already been paid.');
        if (!Number.isSafeInteger(participant.totalEntryFeePaisa) || participant.totalEntryFeePaisa <= 0) {
          throw new HttpError(409, 'TOURNAMENT_ENTRY_NOT_PAYABLE', 'This team does not have an entry fee to pay.');
        }

        const method = parsed.data.method as PaymentMethod;
        const existing = await tx.payment.findFirst({
          where: { tournamentParticipantId: participant.id, status: { in: [...ACTIVE_PAYMENT_STATUSES] } },
          orderBy: { createdAt: 'desc' }, include: paymentDetailsInclude,
        });
        if (existing) {
          if (existing.method !== method) throw new HttpError(409, 'PAYMENT_METHOD_LOCKED', 'An active entry payment already exists with a different method.');
          return { payment: existing, created: false };
        }

        const status = method === 'ONLINE' ? 'PENDING' as const
          : method === 'PAY_AT_VENUE' ? 'DUE_AT_VENUE' as const : 'AWAITING_TRANSFER' as const;
        const payment = await tx.payment.create({ data: {
          userId: request.auth!.userId,
          provider: method === 'ONLINE' ? gateway.provider : 'MANUAL', method,
          environment: method === 'ONLINE' ? gateway.environment : 'MANUAL',
          purpose: 'TOURNAMENT_ENTRY', status, amountPaisa: participant.totalEntryFeePaisa, currency: 'PKR',
          tournamentParticipantId: participant.id,
          idempotencyKey: `tournament-entry:${participant.id}:${randomUUID()}`,
        } });
        await tx.tournamentParticipant.update({ where: { id: participant.id }, data: { paymentStatus: 'PENDING' } });
        if (method !== 'ONLINE') await tx.paymentStatusAudit.create({ data: {
          paymentId: payment.id, actorUserId: request.auth!.userId, previousStatus: null, newStatus: status,
          amountPaisa: payment.amountPaisa, reason: method === 'PAY_AT_VENUE' ? 'TOURNAMENT_ENTRY_DUE_AT_VENUE' : 'TOURNAMENT_ENTRY_BANK_TRANSFER_SELECTED',
        } });
        const detailed = await tx.payment.findUnique({ where: { id: payment.id }, include: paymentDetailsInclude });
        if (!detailed) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
        return { payment: detailed, created: true };
      });
      response.status(result.created ? 201 : 200).json(apiSuccess({ payment: paymentDto(result.payment) }));
    } catch (error) { next(mapPaymentError(error)); }
  });

  router.post('/payments/:paymentId/checkout', authenticate, async (request, response, next) => {
    try {
      const paymentId = routeId(request, 'paymentId');
      const existing = await loadPayment(prisma, paymentId);
      if (existing.userId !== request.auth!.userId) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
      if (existing.method !== 'ONLINE' || existing.provider !== gateway.provider) {
        throw new HttpError(409, 'ONLINE_CHECKOUT_UNAVAILABLE', 'This payment does not use the configured online provider.');
      }
      if (existing.status === 'SUCCEEDED') {
        response.status(200).json(apiSuccess(paymentViewForCheckout(existing, null, existing.provider === 'DEVELOPMENT_MOCK')));
        return;
      }
      if (existing.status !== 'PENDING') throw new HttpError(409, 'PAYMENT_NOT_PENDING', 'This payment is no longer awaiting online checkout.');
      const booking = relatedBooking(existing);
      if (!paymentTargetIsOpen(existing)) {
        throw new HttpError(409, booking ? 'BOOKING_NOT_PAYABLE' : 'TOURNAMENT_NOT_PAYABLE', 'This payment target is no longer accepting payment.');
      }
      if (existing.checkoutUrl && existing.providerReference) {
        response.status(200).json(apiSuccess(paymentViewForCheckout(existing, existing.checkoutUrl, false)));
        return;
      }

      const claimed = await prisma.payment.updateMany({
        where: { id: paymentId, status: 'PENDING', checkoutUrl: null }, data: { status: 'PROCESSING' },
      });
      if (claimed.count !== 1) throw new HttpError(409, 'CHECKOUT_IN_PROGRESS', 'A checkout request is already being processed. Refresh payment status shortly.');
      let checkout;
      try {
        checkout = await gateway.createCheckout({ paymentId, amountPaisa: existing.amountPaisa });
      } catch (error) {
        await prisma.payment.updateMany({ where: { id: paymentId, status: 'PROCESSING' }, data: { status: 'PENDING' } });
        throw error;
      }
      const payment = await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'PENDING', providerReference: checkout.providerReference,
          checkoutUrl: checkout.checkoutUrl,
          ...(checkout.simulation ? { metadata: { simulation: true, environment: 'development' } } : {}),
        }, include: paymentDetailsInclude,
      });
      response.status(200).json(apiSuccess(paymentViewForCheckout(
        payment, checkout.checkoutUrl, checkout.simulation,
        checkout.simulation ? 'Development simulation only. No hosted checkout or real payment was created.' : undefined,
      )));
    } catch (error) { next(mapPaymentError(error)); }
  });

  router.get('/payments/:paymentId', authenticate, async (request, response, next) => {
    try {
      const payment = await loadPayment(prisma, routeId(request, 'paymentId'));
      if (!mayReadPayment(payment, request.auth!.userId, request.auth!.role)) {
        throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
      }
      response.status(200).json(apiSuccess({
        payment: paymentDto(payment), bookingStatus: relatedBooking(payment)?.status ?? null,
        tournamentStatus: relatedTournament(payment)?.status ?? null,
      }));
    } catch (error) { next(error); }
  });

  router.post('/payments/:paymentId/simulate', authenticate, async (request, response, next) => {
    const parsed = mockPaymentResultSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    if (nodeEnv === 'production' || gateway.provider !== 'DEVELOPMENT_MOCK') {
      response.status(404).json(apiError('NOT_FOUND', 'The requested route was not found.'));
      return;
    }
    try {
      const payment = await loadPayment(prisma, routeId(request, 'paymentId'));
      if (payment.userId !== request.auth!.userId || payment.provider !== 'DEVELOPMENT_MOCK' || payment.method !== 'ONLINE') {
        throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
      }
      const status = parsed.data.result === 'succeeded' ? 'SUCCEEDED'
        : parsed.data.result === 'failed' ? 'FAILED' : 'CANCELLED';
      const result = await transitionPayment(prisma, {
        paymentId: payment.id, status, actorUserId: request.auth!.userId, reason: `DEVELOPMENT_SIMULATION_${status}`,
      });
      response.status(200).json(apiSuccess({ payment: paymentDto(result.payment), simulation: true, environment: 'development' }));
    } catch (error) { next(mapPaymentError(error)); }
  });

  router.post('/webhooks/safepay', async (request, response, next) => {
    try {
      const signature = request.header('x-sfpy-signature');
      if (gateway.provider !== 'SAFEPAY' || !gateway.verifyWebhook(request.body, signature)) {
        response.status(401).json(apiError('INVALID_WEBHOOK_SIGNATURE', 'The Safepay webhook signature is invalid.'));
        return;
      }
      const root = objectRecord(request.body)!;
      const data = objectRecord(root.data)!;
      const notification = objectRecord(data.notification) ?? data;
      const tracker = asString(notification.tracker) ?? asString(data.tracker);
      const reference = asString(notification.reference) ?? asString(data.reference);
      const state = (asString(notification.state) ?? asString(data.state))?.toUpperCase();
      const currency = (asString(notification.currency) ?? asString(data.currency))?.toUpperCase();
      const amountPaisa = parseSafepayAmount(notification.amount ?? data.amount);
      const eventType = asString(root.type) ?? asString(data.type) ?? request.header('x-sfpy-event-type') ?? 'payment:event';
      if (!tracker || !state || !currency || amountPaisa === undefined) {
        response.status(400).json(apiError('INVALID_WEBHOOK_PAYLOAD', 'The Safepay webhook payload is incomplete.'));
        return;
      }
      const eventId = request.header('x-sfpy-event-id')
        ?? createHash('sha256').update(`${signature}:${tracker}:${state}:${reference ?? ''}`).digest('hex');
      const payment = await prisma.payment.findFirst({
        where: { provider: 'SAFEPAY', method: 'ONLINE', providerReference: tracker },
        select: { id: true, amountPaisa: true },
      });
      const validReference = !reference || !payment || reference === payment.id;
      const validAmount = Boolean(payment && currency === 'PKR' && payment.amountPaisa === amountPaisa && validReference);
      const transition = state === 'PAID' || state === 'SUCCEEDED' ? 'SUCCEEDED'
        : state === 'FAILED' ? 'FAILED' : state === 'CANCELLED' ? 'CANCELLED' : state === 'EXPIRED' ? 'EXPIRED' : undefined;

      await prisma.$transaction(async tx => {
        await tx.webhookEvent.create({ data: {
          provider: 'SAFEPAY', providerEventId: eventId.slice(0, 255), paymentId: payment?.id ?? null,
          signatureVerified: true, eventType,
          redactedPayload: {
            tracker, reference: reference ?? null, state, currency, amountPaisa,
          },
          processingError: !payment ? 'PAYMENT_NOT_FOUND' : !validAmount ? 'PAYMENT_DATA_MISMATCH' : null,
          processedAt: new Date(),
        } });
        if (payment && validAmount && transition) {
          await transitionPaymentInTransaction(tx, {
            paymentId: payment.id, newStatus: transition, actorUserId: null,
            reason: `SAFEPAY_WEBHOOK_${state}`,
          });
        }
      });
      response.status(200).json(apiSuccess({ received: true, processed: Boolean(payment && validAmount && transition) }));
    } catch (error) {
      if (prismaCode(error) === 'P2002') {
        response.status(200).json(apiSuccess({ received: true, duplicate: true }));
        return;
      }
      next(mapPaymentError(error));
    }
  });

  router.put('/vendors/me/payment-instructions', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = paymentInstructionsSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const vendor = await prisma.vendorProfile.findUnique({ where: { ownerUserId: request.auth!.userId }, select: { id: true } });
      if (!vendor) throw new HttpError(404, 'VENDOR_PROFILE_NOT_FOUND', 'The vendor profile was not found.');
      const input = parsed.data;
      const instructions = await prisma.vendorPaymentInstructions.upsert({
        where: { vendorProfileId: vendor.id },
        create: {
          vendorProfileId: vendor.id, accountTitle: input.accountTitle, bankName: input.bankName,
          iban: input.iban ?? null, accountNumber: input.accountNumber ?? null,
          instructions: input.instructions ?? null, active: input.active,
        },
        update: {
          accountTitle: input.accountTitle, bankName: input.bankName,
          iban: input.iban ?? null, accountNumber: input.accountNumber ?? null,
          instructions: input.instructions ?? null, active: input.active,
        },
      });
      response.status(200).json(apiSuccess({
        accountTitle: instructions.accountTitle, bankName: instructions.bankName,
        iban: instructions.iban, accountNumber: instructions.accountNumber,
        instructions: instructions.instructions, active: instructions.active,
      }));
    } catch (error) { next(error); }
  });

  router.get('/bookings/:bookingId/payment-instructions', authenticate, playerOnly, async (request, response, next) => {
    try {
      const bookingId = routeId(request, 'bookingId');
      const booking = await prisma.booking.findFirst({
        where: {
          id: bookingId,
          OR: [
            { customerUserId: request.auth!.userId },
            { participants: { some: { userId: request.auth!.userId } } },
          ],
        },
        select: { id: true, venue: { select: { vendorProfileId: true } } },
      });
      if (!booking) throw new HttpError(404, 'BOOKING_NOT_FOUND', 'The booking was not found.');
      const payment = await prisma.payment.findFirst({
        where: {
          userId: request.auth!.userId, method: 'BANK_TRANSFER',
          contribution: { bookingParticipant: { bookingId, userId: request.auth!.userId } },
        }, select: { id: true },
      });
      if (!payment) throw new HttpError(409, 'BANK_TRANSFER_NOT_SELECTED', 'Select bank transfer for your booking contribution first.');
      const instructions = await prisma.vendorPaymentInstructions.findFirst({
        where: { vendorProfileId: booking.venue.vendorProfileId, active: true },
      });
      if (!instructions) throw new HttpError(404, 'BANK_INSTRUCTIONS_NOT_CONFIGURED', 'This venue has not configured active bank transfer instructions.');
      response.status(200).json(apiSuccess({
        bankName: instructions.bankName, accountTitle: instructions.accountTitle,
        iban: instructions.iban, accountNumber: instructions.accountNumber, instructions: instructions.instructions,
      }));
    } catch (error) { next(error); }
  });

  router.get('/tournaments/:tournamentId/payment-instructions', authenticate, playerOnly, async (request, response, next) => {
    try {
      const tournamentId = routeId(request, 'tournamentId');
      const participant = await prisma.tournamentParticipant.findUnique({
        where: { tournamentId_userId: { tournamentId, userId: request.auth!.userId } },
        select: { id: true, tournament: { select: { venue: { select: { vendorProfileId: true } } } } },
      });
      if (!participant) throw new HttpError(404, 'TEAM_NOT_FOUND', 'Your tournament team was not found.');
      const payment = await prisma.payment.findFirst({
        where: { userId: request.auth!.userId, tournamentParticipantId: participant.id, method: 'BANK_TRANSFER' },
        select: { id: true },
      });
      if (!payment) throw new HttpError(409, 'BANK_TRANSFER_NOT_SELECTED', 'Select bank transfer for this tournament entry first.');
      const instructions = await prisma.vendorPaymentInstructions.findFirst({
        where: { vendorProfileId: participant.tournament.venue.vendorProfileId, active: true },
      });
      if (!instructions) throw new HttpError(404, 'BANK_INSTRUCTIONS_NOT_CONFIGURED', 'This tournament venue has not configured active bank transfer instructions.');
      response.status(200).json(apiSuccess({
        bankName: instructions.bankName, accountTitle: instructions.accountTitle,
        iban: instructions.iban, accountNumber: instructions.accountNumber, instructions: instructions.instructions,
      }));
    } catch (error) { next(error); }
  });

  router.get('/vendors/me/payments/transfers', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = transferListQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const { page, limit } = parsed.data;
      const { payments, total } = await listOwnedPayments('BANK_TRANSFER', 'PROOF_SUBMITTED', request.auth!.userId, page, limit);
      response.status(200).json(apiSuccess(payments.map(payment => ({
        payment: paymentDto(payment),
        payer: payment.user ? { id: payment.user.id, name: payment.user.name } : null,
        booking: relatedBooking(payment) ? {
          id: relatedBooking(payment)!.id,
          venueId: relatedBooking(payment)!.venue.id,
          venueName: relatedBooking(payment)!.venue.name,
          courtId: relatedBooking(payment)!.court.id,
          courtName: relatedBooking(payment)!.court.name,
          customerName: relatedBooking(payment)!.customerName,
          startsAt: relatedBooking(payment)!.startsAt.toISOString(),
          endsAt: relatedBooking(payment)!.endsAt.toISOString(),
        } : null,
        tournament: relatedTournament(payment) ? {
          id: relatedTournament(payment)!.id, title: relatedTournament(payment)!.title,
          venueName: relatedTournament(payment)!.venue.name,
          startsAt: relatedTournament(payment)!.startsAt.toISOString(),
        } : null,
      })), { page, limit, total }));
    } catch (error) { next(error); }
  });

  router.get('/vendors/me/payments/venue-due', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = transferListQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const { page, limit } = parsed.data;
      const { payments, total } = await listOwnedPayments('PAY_AT_VENUE', 'DUE_AT_VENUE', request.auth!.userId, page, limit);
      response.status(200).json(apiSuccess(payments.map(payment => ({
        payment: paymentDto(payment),
        payer: payment.user ? { id: payment.user.id, name: payment.user.name } : null,
        booking: relatedBooking(payment) ? {
          id: relatedBooking(payment)!.id,
          venueName: relatedBooking(payment)!.venue.name,
          courtName: relatedBooking(payment)!.court.name,
          customerName: relatedBooking(payment)!.customerName,
          startsAt: relatedBooking(payment)!.startsAt.toISOString(),
          endsAt: relatedBooking(payment)!.endsAt.toISOString(),
        } : null,
        tournament: relatedTournament(payment) ? {
          id: relatedTournament(payment)!.id, title: relatedTournament(payment)!.title,
          venueName: relatedTournament(payment)!.venue.name,
          startsAt: relatedTournament(payment)!.startsAt.toISOString(),
        } : null,
      })), { page, limit, total }));
    } catch (error) { next(error); }
  });

  router.post('/vendors/me/payments/:paymentId/mark-cash-received', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = cashReceiptSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const payment = await requireVendorOwnedPayment(routeId(request, 'paymentId'), request.auth!.userId);
      if (payment.method !== 'PAY_AT_VENUE' || payment.provider !== 'MANUAL' || payment.status !== 'DUE_AT_VENUE') {
        throw new HttpError(409, 'CASH_PAYMENT_NOT_DUE', 'This payment is not awaiting venue cash collection.');
      }
      if (parsed.data.amountPaisa !== payment.amountPaisa) {
        throw new HttpError(409, 'PAYMENT_AMOUNT_MISMATCH', 'The collected amount must match the server-calculated amount due.');
      }
      const result = await prisma.$transaction(tx => transitionPaymentInTransaction(tx, {
        paymentId: payment.id, newStatus: 'SUCCEEDED', actorUserId: request.auth!.userId,
        reason: parsed.data.note || 'VENDOR_CONFIRMED_CASH_COLLECTION',
      }));
      response.status(200).json(apiSuccess({ payment: paymentDto(result.payment), collected: result.changed }));
    } catch (error) { next(mapPaymentError(error)); }
  });

  router.post('/vendors/me/payments/:paymentId/approve-transfer', authenticate, vendorOnly, async (request, response, next) => {
    try {
      const paymentId = routeId(request, 'paymentId');
      await requireVendorOwnedPayment(paymentId, request.auth!.userId);
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "payments" WHERE "id" = ${paymentId}::uuid FOR UPDATE`);
        const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: paymentDetailsInclude });
        if (!payment) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
        if (payment.method !== 'BANK_TRANSFER' || payment.status !== 'PROOF_SUBMITTED') {
          throw new HttpError(409, 'TRANSFER_NOT_PENDING_REVIEW', 'This transfer is not waiting for vendor review.');
        }
        const receipt = payment.receipts.find(item => item.status === 'SUBMITTED');
        if (!receipt) throw new HttpError(409, 'RECEIPT_NOT_FOUND', 'The submitted transfer receipt was not found.');
        await tx.paymentReceipt.update({ where: { id: receipt.id }, data: {
          status: 'APPROVED', reviewedByUserId: request.auth!.userId, reviewedAt: new Date(), rejectionReason: null,
        } });
        return transitionPaymentInTransaction(tx, {
          paymentId, newStatus: 'SUCCEEDED', actorUserId: request.auth!.userId, reason: 'VENDOR_APPROVED_BANK_TRANSFER',
        });
      });
      response.status(200).json(apiSuccess({ payment: paymentDto(result.payment), approved: result.changed }));
    } catch (error) { next(mapPaymentError(error)); }
  });

  router.post('/vendors/me/payments/:paymentId/reject-transfer', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = rejectTransferSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const paymentId = routeId(request, 'paymentId');
      await requireVendorOwnedPayment(paymentId, request.auth!.userId);
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "payments" WHERE "id" = ${paymentId}::uuid FOR UPDATE`);
        const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: paymentDetailsInclude });
        if (!payment) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
        if (payment.method !== 'BANK_TRANSFER' || payment.status !== 'PROOF_SUBMITTED') {
          throw new HttpError(409, 'TRANSFER_NOT_PENDING_REVIEW', 'This transfer is not waiting for vendor review.');
        }
        const receipt = payment.receipts.find(item => item.status === 'SUBMITTED');
        if (!receipt) throw new HttpError(409, 'RECEIPT_NOT_FOUND', 'The submitted transfer receipt was not found.');
        await tx.paymentReceipt.update({ where: { id: receipt.id }, data: {
          status: 'REJECTED', reviewedByUserId: request.auth!.userId, reviewedAt: new Date(), rejectionReason: parsed.data.reason,
        } });
        return transitionPaymentInTransaction(tx, {
          paymentId, newStatus: 'REJECTED', actorUserId: request.auth!.userId,
          reason: `VENDOR_REJECTED_BANK_TRANSFER: ${parsed.data.reason}`,
        });
      });
      response.status(200).json(apiSuccess({ payment: paymentDto(result.payment), rejected: result.changed }));
    } catch (error) { next(mapPaymentError(error)); }
  });

  router.post('/payments/:paymentId/receipt/signed-upload', authenticate, playerOnly, async (request, response, next) => {
    const parsed = receiptUploadSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const payment = await loadPayment(prisma, routeId(request, 'paymentId'));
      if (payment.userId !== request.auth!.userId || payment.method !== 'BANK_TRANSFER') {
        throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
      }
      if (!['AWAITING_TRANSFER', 'REJECTED'].includes(payment.status)) {
        throw new HttpError(409, 'RECEIPT_UPLOAD_NOT_ALLOWED', 'A receipt cannot be uploaded in the current payment state.');
      }
      if (!paymentTargetIsOpen(payment)) throw new HttpError(409, 'PAYMENT_TARGET_CLOSED', 'This booking or tournament is no longer accepting transfer receipts.');
      const extension = validateReceiptFile(parsed.data);
      const upload = await storage.createSignedUpload({
        payerUserId: request.auth!.userId, paymentId: payment.id,
        ...parsed.data, mimeType: parsed.data.mimeType, fileName: `${parsed.data.fileName.replace(/[\\/]/g, '_')}${parsed.data.fileName.toLowerCase().endsWith(extension) ? '' : extension}`,
      });
      response.status(200).json(apiSuccess({
        storagePath: upload.storagePath, signedUrl: upload.signedUrl, token: upload.token,
        expiresInSeconds: upload.expiresInSeconds, maxSizeBytes: MAX_RECEIPT_BYTES,
      }));
    } catch (error) { next(error); }
  });

  router.post('/payments/:paymentId/receipt', authenticate, playerOnly, async (request, response, next) => {
    const parsed = receiptConfirmSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const paymentId = routeId(request, 'paymentId');
      const initial = await loadPayment(prisma, paymentId);
      if (initial.userId !== request.auth!.userId || initial.method !== 'BANK_TRANSFER') {
        throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
      }
      if (!['AWAITING_TRANSFER', 'REJECTED'].includes(initial.status)) {
        throw new HttpError(409, 'RECEIPT_UPLOAD_NOT_ALLOWED', 'A receipt cannot be submitted in the current payment state.');
      }
      const expectedPrefix = `${request.auth!.userId}/${paymentId}/`;
      const extension = validateReceiptFile(parsed.data);
      if (!parsed.data.storagePath.startsWith(expectedPrefix) || parsed.data.storagePath.includes('..')
        || !parsed.data.storagePath.toLowerCase().endsWith(extension)) {
        throw new HttpError(400, 'INVALID_RECEIPT_PATH', 'The receipt object path is not valid for this payment.');
      }
      const objectInfo = await storage.getObjectInfo(parsed.data.storagePath);
      if (!objectInfo.exists) throw new HttpError(409, 'RECEIPT_NOT_UPLOADED', 'The receipt file has not been uploaded.');
      const actualSizeBytes = objectInfo.sizeBytes;
      if (actualSizeBytes === undefined || actualSizeBytes !== parsed.data.sizeBytes || actualSizeBytes > MAX_RECEIPT_BYTES) {
        throw new HttpError(400, 'RECEIPT_SIZE_MISMATCH', 'The uploaded receipt size does not match the confirmed file metadata.');
      }
      if (!objectInfo.mimeType || objectInfo.mimeType.toLowerCase() !== parsed.data.mimeType) {
        throw new HttpError(400, 'RECEIPT_TYPE_MISMATCH', 'The uploaded receipt content type does not match the confirmed file type.');
      }
      const now = new Date();
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "payments" WHERE "id" = ${paymentId}::uuid FOR UPDATE`);
        const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: paymentDetailsInclude });
        if (!payment || payment.userId !== request.auth!.userId) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
        if (!['AWAITING_TRANSFER', 'REJECTED'].includes(payment.status)) {
          throw new HttpError(409, 'RECEIPT_UPLOAD_NOT_ALLOWED', 'A receipt has already been submitted for review.');
        }
        if (payment.receipts.length >= MAX_RECEIPT_ATTEMPTS) {
          throw new HttpError(409, 'RECEIPT_ATTEMPT_LIMIT', 'The maximum number of transfer receipt submissions has been reached.');
        }
        if (!paymentTargetIsOpen(payment, now)) throw new HttpError(409, 'PAYMENT_TARGET_CLOSED', 'This booking or tournament is no longer accepting transfer receipts.');
        const booking = relatedBooking(payment);
        const previousStatus = payment.status;
        const receipt = await tx.paymentReceipt.create({ data: {
          paymentId, storagePath: parsed.data.storagePath, fileName: parsed.data.fileName.replace(/[\\/]/g, '_'),
          mimeType: parsed.data.mimeType, sizeBytes: actualSizeBytes, status: 'SUBMITTED',
        } });
        await tx.payment.update({ where: { id: paymentId }, data: { status: 'PROOF_SUBMITTED' } });
        await tx.paymentStatusAudit.create({ data: {
          paymentId, actorUserId: request.auth!.userId, previousStatus, newStatus: 'PROOF_SUBMITTED',
          amountPaisa: payment.amountPaisa, reason: 'BANK_TRANSFER_RECEIPT_SUBMITTED',
        } });
        if (booking?.status === 'PENDING_PAYMENT') {
          await tx.booking.update({ where: { id: booking.id }, data: { holdExpiresAt: new Date(now.getTime() + RECEIPT_REVIEW_HOLD_MS), paymentStatus: 'PENDING' } });
        }
        const fresh = await tx.payment.findUnique({ where: { id: paymentId }, include: paymentDetailsInclude });
        if (!fresh) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
        return { payment: fresh, receiptId: receipt.id };
      });
      response.status(201).json(apiSuccess({ payment: paymentDto(result.payment), receiptId: result.receiptId, reviewStatus: 'SUBMITTED' }));
    } catch (error) { next(mapPaymentError(error)); }
  });

  router.get('/payments/:paymentId/receipt', authenticate, async (request, response, next) => {
    try {
      const payment = await loadPayment(prisma, routeId(request, 'paymentId'));
      if (!mayReadPayment(payment, request.auth!.userId, request.auth!.role)) {
        throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'The payment was not found.');
      }
      const receipt = payment.receipts[0];
      if (!receipt) throw new HttpError(404, 'RECEIPT_NOT_FOUND', 'The payment has no submitted receipt.');
      const signedUrl = await storage.createSignedDownload(receipt.storagePath, 300);
      response.status(200).json(apiSuccess({
        signedUrl, expiresInSeconds: 300,
        receipt: { id: receipt.id, fileName: receipt.fileName, mimeType: receipt.mimeType, sizeBytes: receipt.sizeBytes, status: receipt.status },
      }));
    } catch (error) { next(error); }
  });

  return router;
}
