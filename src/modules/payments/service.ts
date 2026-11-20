import { Prisma } from '../../generated/prisma/client.js';
import { paisaToPKR } from '../bookings/service.js';

export const paymentDetailsInclude = {
  user: { select: { id: true, name: true } },
  contribution: {
    include: {
      bookingParticipant: {
        include: {
          user: { select: { id: true, name: true } },
          booking: {
            include: {
              venue: { select: { id: true, name: true, vendorProfile: { select: { ownerUserId: true } } } },
              court: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  },
  booking: {
    include: {
      venue: { select: { id: true, name: true, vendorProfile: { select: { ownerUserId: true } } } },
      court: { select: { id: true, name: true } },
    },
  },
  tournamentParticipant: {
    include: {
      tournament: {
        include: {
          venue: { select: { id: true, name: true, city: true, vendorProfile: { select: { ownerUserId: true } } } },
          organizer: { select: { id: true, name: true } },
        },
      },
    },
  },
  receipts: { orderBy: { submittedAt: 'desc' as const } },
} satisfies Prisma.PaymentInclude;

export type PaymentDetails = Prisma.PaymentGetPayload<{ include: typeof paymentDetailsInclude }>;

export function relatedBooking(payment: PaymentDetails) {
  return payment.booking ?? payment.contribution?.bookingParticipant.booking ?? null;
}

export function relatedTournament(payment: PaymentDetails) {
  return payment.tournamentParticipant?.tournament ?? null;
}

export function paymentDto(payment: PaymentDetails, includeCheckoutUrl = false) {
  return {
    id: payment.id,
    bookingId: payment.bookingId ?? payment.contribution?.bookingParticipant.bookingId ?? null,
    tournamentId: payment.tournamentParticipant?.tournament.id ?? null,
    tournamentParticipantId: payment.tournamentParticipantId,
    contributionId: payment.contributionId,
    method: payment.method,
    provider: payment.provider,
    environment: payment.environment,
    purpose: payment.purpose,
    status: payment.status,
    amountPaisa: payment.amountPaisa,
    amountPKR: paisaToPKR(payment.amountPaisa),
    currency: payment.currency,
    providerReference: payment.providerReference,
    ...(includeCheckoutUrl ? { checkoutUrl: payment.checkoutUrl } : {}),
    simulation: payment.provider === 'DEVELOPMENT_MOCK',
    settledAt: payment.settledAt?.toISOString() ?? null,
    receipts: payment.receipts.map(receipt => ({
      id: receipt.id,
      status: receipt.status,
      submittedAt: receipt.submittedAt.toISOString(),
      reviewedAt: receipt.reviewedAt?.toISOString() ?? null,
      rejectionReason: receipt.rejectionReason,
    })),
    createdAt: payment.createdAt.toISOString(),
  };
}

export async function reconcileBookingPaymentState(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId }, select: { id: true, status: true, totalPaisa: true, paymentStatus: true },
  });
  if (!booking) return;

  const [contributions, directPayments, allPayments] = await Promise.all([
    tx.paymentContribution.findMany({
      where: { bookingParticipant: { bookingId } }, select: { amountDuePaisa: true, amountPaidPaisa: true },
    }),
    tx.payment.findMany({ where: { bookingId }, select: { status: true, amountPaisa: true } }),
    tx.payment.findMany({
      where: { contribution: { bookingParticipant: { bookingId } } }, select: { status: true },
    }),
  ]);

  const contributionPaid = contributions.reduce((sum, contribution) => sum + contribution.amountPaidPaisa, 0);
  const directPaid = directPayments.reduce((sum, payment) => sum + (payment.status === 'SUCCEEDED' ? payment.amountPaisa : 0), 0);
  const paidPaisa = contributionPaid + directPaid;
  const statuses = [...directPayments.map(payment => payment.status), ...allPayments.map(payment => payment.status)];
  const dueAtVenue = statuses.includes('DUE_AT_VENUE');
  const hasOpenPayment = statuses.some(status => ['PENDING', 'PROCESSING', 'AWAITING_TRANSFER', 'PROOF_SUBMITTED'].includes(status));
  const hasRejectedOrFailed = statuses.some(status => ['FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(status));

  if (booking.status === 'CANCELLED' || booking.status === 'EXPIRED') {
    const paymentStatus = paidPaisa > 0 ? 'REFUND_PENDING' : booking.paymentStatus;
    if (paymentStatus !== booking.paymentStatus) await tx.booking.update({ where: { id: bookingId }, data: { paymentStatus } });
    return;
  }
  if (booking.totalPaisa === 0 || paidPaisa >= booking.totalPaisa) {
    await tx.booking.update({ where: { id: bookingId }, data: { status: 'CONFIRMED', paymentStatus: 'PAID', holdExpiresAt: null } });
    return;
  }
  if (dueAtVenue) {
    await tx.booking.update({ where: { id: bookingId }, data: {
      status: 'CONFIRMED', paymentStatus: paidPaisa > 0 ? 'PARTIALLY_PAID' : 'DUE_AT_VENUE', holdExpiresAt: null,
    } });
    return;
  }
  if (paidPaisa > 0) {
    await tx.booking.update({ where: { id: bookingId }, data: {
      status: booking.status === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING_PAYMENT',
      paymentStatus: 'PARTIALLY_PAID',
    } });
    return;
  }
  await tx.booking.update({ where: { id: bookingId }, data: {
    paymentStatus: hasOpenPayment ? 'PENDING' : hasRejectedOrFailed ? 'FAILED' : 'PENDING',
  } });
}

export async function markContributionPaid(tx: Prisma.TransactionClient, payment: {
  contributionId: string | null; bookingId: string | null; amountPaisa: number;
}): Promise<string | null> {
  if (!payment.contributionId) return payment.bookingId;
  const contribution = await tx.paymentContribution.findUnique({
    where: { id: payment.contributionId },
    include: { bookingParticipant: { select: { id: true, bookingId: true, userId: true } } },
  });
  if (!contribution) return null;
  const remaining = contribution.amountDuePaisa - contribution.amountPaidPaisa;
  if (payment.amountPaisa > remaining) throw new Error('PAYMENT_CONTRIBUTION_OVERPAYMENT');
  const amountPaidPaisa = contribution.amountPaidPaisa + payment.amountPaisa;
  const status = amountPaidPaisa >= contribution.amountDuePaisa ? 'PAID' as const : 'PARTIALLY_PAID' as const;
  await tx.paymentContribution.update({ where: { id: contribution.id }, data: { amountPaidPaisa, status } });
  await tx.bookingParticipant.update({ where: { id: contribution.bookingParticipant.id }, data: { paymentStatus: status } });
  const room = await tx.gameRoom.findUnique({ where: { bookingId: contribution.bookingParticipant.bookingId }, select: { id: true } });
  if (room) await tx.gameRoomShare.updateMany({
    where: { gameRoomId: room.id, userId: contribution.bookingParticipant.userId },
    data: { status: status === 'PAID' ? 'PAID' : 'PENDING' },
  });
  return contribution.bookingParticipant.bookingId;
}

export async function transitionPaymentInTransaction(tx: Prisma.TransactionClient, input: {
  paymentId: string;
  newStatus: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
  actorUserId: string | null;
  reason: string;
  now?: Date;
}): Promise<{ payment: PaymentDetails; changed: boolean }> {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "payments" WHERE "id" = ${input.paymentId}::uuid FOR UPDATE`);
  const current = await tx.payment.findUnique({ where: { id: input.paymentId }, include: paymentDetailsInclude });
  if (!current) throw new Error('PAYMENT_NOT_FOUND');
  if (current.status === input.newStatus || ['SUCCEEDED', 'REFUNDED', 'REFUND_PENDING'].includes(current.status)) {
    return { payment: current, changed: false };
  }

  const successTransition = input.newStatus === 'SUCCEEDED';
  const allowedFrom = successTransition
    ? ['PENDING', 'PROCESSING', 'DUE_AT_VENUE', 'AWAITING_TRANSFER', 'PROOF_SUBMITTED', 'EXPIRED']
    : ['PENDING', 'PROCESSING', 'AWAITING_TRANSFER', 'PROOF_SUBMITTED'];
  if (!allowedFrom.includes(current.status)) throw new Error('PAYMENT_STATE_TRANSITION_INVALID');

  const now = input.now ?? new Date();
  const payment = await tx.payment.update({
    where: { id: current.id },
    data: { status: input.newStatus, ...(successTransition ? { settledAt: now } : {}) },
  });
  await tx.paymentStatusAudit.create({ data: {
    paymentId: current.id, actorUserId: input.actorUserId, previousStatus: current.status,
    newStatus: input.newStatus, amountPaisa: current.amountPaisa, reason: input.reason,
  } });

  const booking = relatedBooking(current);
  if (successTransition) {
    await markContributionPaid(tx, { contributionId: current.contributionId, bookingId: current.bookingId, amountPaisa: current.amountPaisa });
  } else if (current.contributionId) {
    const contribution = await tx.paymentContribution.findUnique({
      where: { id: current.contributionId },
      include: { bookingParticipant: { select: { id: true } } },
    });
    if (contribution) {
      const contributionStatus = contribution.amountPaidPaisa > 0 ? 'PARTIALLY_PAID' as const : 'FAILED' as const;
      await tx.paymentContribution.update({ where: { id: contribution.id }, data: { status: contributionStatus } });
      await tx.bookingParticipant.update({ where: { id: contribution.bookingParticipant.id }, data: { paymentStatus: contributionStatus } });
    }
  }

  if (current.tournamentParticipantId) {
    await tx.tournamentParticipant.update({
      where: { id: current.tournamentParticipantId },
      data: { paymentStatus: successTransition ? 'PAID' : 'FAILED' },
    });
  }

  const bookingId = booking?.id ?? current.bookingId;
  if (bookingId) await reconcileBookingPaymentState(tx, bookingId);
  const fresh = await tx.payment.findUnique({ where: { id: payment.id }, include: paymentDetailsInclude });
  if (!fresh) throw new Error('PAYMENT_NOT_FOUND');
  return { payment: fresh, changed: true };
}
