import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { utcInstantToLocal } from './schedule.js';

export const bookingDetailsInclude = {
  venue: { select: { name: true } },
  court: { select: { name: true } },
  items: true,
  payments: { select: { id: true, userId: true, method: true, status: true, amountPaisa: true, purpose: true } },
  participants: {
    include: {
      user: { select: { id: true, name: true } },
      contribution: { include: {
        payments: { select: { id: true, userId: true, method: true, status: true, amountPaisa: true, purpose: true } },
      } },
    },
    orderBy: { joinedAt: 'asc' },
  },
} satisfies Prisma.BookingInclude;

export type BookingDetails = Prisma.BookingGetPayload<{ include: typeof bookingDetailsInclude }>;

export function paisaToPKR(paisa: number): number {
  return paisa % 100 === 0 ? paisa / 100 : Number((paisa / 100).toFixed(2));
}

export function bookingDto(booking: BookingDetails) {
  const localStart = utcInstantToLocal(booking.startsAt, booking.timeZone);
  const localEnd = utcInstantToLocal(booking.endsAt, booking.timeZone);
  const durationMinutes = Math.round((booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000);
  const source = booking.source === 'APP' ? 'player' : booking.source === 'WALK_IN' ? 'walk-in' : 'tournament';
  return {
    id: booking.id,
    source,
    status: booking.status,
    paymentMode: booking.paymentMode,
    paymentStatus: booking.paymentStatus,
    venueId: booking.venueId,
    venueName: booking.venue.name,
    courtId: booking.courtId,
    groundId: booking.courtId,
    groundName: booking.court.name,
    date: localStart?.date ?? null,
    startTime: localStart?.time ?? null,
    endTime: localEnd?.time ?? null,
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    timeZone: booking.timeZone,
    durationMinutes,
    customerUserId: booking.customerUserId,
    createdByUserId: booking.createdByUserId,
    customerName: booking.customerName,
    customerPhone: booking.customerPhone,
    groundFeePaisa: booking.groundFeePaisa,
    groundFeePKR: paisaToPKR(booking.groundFeePaisa),
    addOns: booking.items.map(item => ({
      equipmentId: item.equipmentItemId,
      name: item.nameSnapshot,
      priceMode: item.priceModeSnapshot,
      unitPricePaisa: item.unitPricePaisa,
      unitPricePKR: paisaToPKR(item.unitPricePaisa),
      quantity: item.quantity,
      lineTotalPaisa: item.lineTotalPaisa,
      lineTotalPKR: paisaToPKR(item.lineTotalPaisa),
    })),
    addOnsTotalPaisa: booking.addOnsTotalPaisa,
    addOnsTotalPKR: paisaToPKR(booking.addOnsTotalPaisa),
    totalPaisa: booking.totalPaisa,
    totalPKR: paisaToPKR(booking.totalPaisa),
    currency: booking.currency,
    holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null,
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
    participants: booking.participants.map(participant => ({
      id: participant.id,
      userId: participant.userId,
      name: participant.user.name,
      isOrganizer: participant.isOrganizer,
      sharePaisa: participant.sharePaisa,
      sharePKR: paisaToPKR(participant.sharePaisa),
      paymentStatus: participant.paymentStatus,
      contribution: participant.contribution ? {
        id: participant.contribution.id,
        amountDuePaisa: participant.contribution.amountDuePaisa,
        amountPaidPaisa: participant.contribution.amountPaidPaisa,
        status: participant.contribution.status,
      } : null,
    })),
    payments: [
      ...(booking.payments ?? []),
      ...booking.participants.flatMap(participant => participant.contribution?.payments ?? []),
    ].map(payment => ({
      id: payment.id, userId: payment.userId, method: payment.method, status: payment.status,
      amountPaisa: payment.amountPaisa, amountPKR: paisaToPKR(payment.amountPaisa), purpose: payment.purpose,
    })),
    createdAt: booking.createdAt.toISOString(),
  };
}

export async function expirePendingHolds(prisma: PrismaClient, now = new Date()): Promise<number> {
  const staleBookings = await prisma.booking.findMany({
    where: { status: 'PENDING_PAYMENT', OR: [{ holdExpiresAt: { lte: now } }, { holdExpiresAt: null }] },
    select: { id: true },
  });
  if (!staleBookings.length) return 0;
  const bookingIds = staleBookings.map(booking => booking.id);

  return prisma.$transaction(async tx => {
    const changed = await tx.booking.updateMany({
      where: { id: { in: bookingIds }, status: 'PENDING_PAYMENT', OR: [{ holdExpiresAt: { lte: now } }, { holdExpiresAt: null }] },
      data: { status: 'EXPIRED', paymentStatus: 'FAILED', holdExpiresAt: null },
    });
    if (!changed.count) return 0;

    const openPayments = await tx.payment.findMany({
      where: {
        status: { in: ['PENDING', 'PROCESSING', 'AWAITING_TRANSFER', 'PROOF_SUBMITTED'] },
        OR: [
          { bookingId: { in: bookingIds } },
          { contribution: { bookingParticipant: { bookingId: { in: bookingIds } } } },
        ],
      },
      select: { id: true, status: true, amountPaisa: true },
    });
    if (openPayments.length) {
      await tx.payment.updateMany({ where: { id: { in: openPayments.map(payment => payment.id) } }, data: { status: 'EXPIRED' } });
      await tx.paymentStatusAudit.createMany({
        data: openPayments.map(payment => ({
          paymentId: payment.id,
          previousStatus: payment.status,
          newStatus: 'EXPIRED' as const,
          amountPaisa: payment.amountPaisa,
          reason: 'BOOKING_HOLD_EXPIRED',
        })),
      });
    }

    await tx.paymentContribution.updateMany({
      where: { bookingParticipant: { bookingId: { in: bookingIds } }, status: { not: 'PAID' } },
      data: { status: 'FAILED' },
    });
    await tx.bookingParticipant.updateMany({
      where: { bookingId: { in: bookingIds }, paymentStatus: { not: 'PAID' } },
      data: { paymentStatus: 'FAILED' },
    });
    return changed.count;
  });
}
