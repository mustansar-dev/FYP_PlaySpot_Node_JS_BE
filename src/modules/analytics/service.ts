import type { PrismaClient } from '../../generated/prisma/client.js';

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SLOT_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED'] as const;

function localDayStartUtc(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) - PKT_OFFSET_MS;
}

function minuteOfDay(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function pkDateKey(value: Date): string {
  return new Date(value.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

interface Interval { start: number; end: number; }

function subtractIntervals(source: Interval[], removals: Interval[]): Interval[] {
  return removals.reduce((current, removal) => current.flatMap(interval => {
    if (removal.end <= interval.start || removal.start >= interval.end) return [interval];
    const fragments: Interval[] = [];
    if (removal.start > interval.start) fragments.push({ start: interval.start, end: removal.start });
    if (removal.end < interval.end) fragments.push({ start: removal.end, end: interval.end });
    return fragments;
  }), source);
}

function overlapMinutes(start: number, end: number, interval: Interval): number {
  return Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start)) / 60_000;
}

export function calculateOccupancy(input: {
  from: string; to: string;
  courts: Array<{ openingTime: string; closingTime: string; availableDays: string[]; blocks: Array<{ startsAt: Date; endsAt: Date }> }>;
  bookings: Array<{ courtId: string; startsAt: Date; endsAt: Date }>;
} & { courtIds: string[] }): { availableCourtMinutes: number; bookedCourtMinutes: number; occupancyPercent: number } {
  let availableCourtMinutes = 0;
  let bookedCourtMinutes = 0;
  const fromMs = localDayStartUtc(input.from);
  const toExclusiveMs = localDayStartUtc(new Date(Date.parse(`${input.to}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10));
  for (let courtIndex = 0; courtIndex < input.courts.length; courtIndex += 1) {
    const court = input.courts[courtIndex]!;
    const courtId = input.courtIds[courtIndex]!;
    const openMinute = minuteOfDay(court.openingTime);
    const closeMinute = minuteOfDay(court.closingTime);
    if (openMinute === undefined || closeMinute === undefined || closeMinute <= openMinute) continue;
    for (let dayMs = fromMs; dayMs < toExclusiveMs; dayMs += 86_400_000) {
      const day = new Date(dayMs + PKT_OFFSET_MS);
      const weekday = DAY_NAMES[day.getUTCDay()]!;
      if (!court.availableDays.includes(weekday)) continue;
      const base = { start: dayMs + openMinute * 60_000, end: dayMs + closeMinute * 60_000 };
      const blocks = court.blocks.map(block => ({ start: block.startsAt.getTime(), end: block.endsAt.getTime() }));
      const freeIntervals = subtractIntervals([base], blocks);
      for (const interval of freeIntervals) {
        availableCourtMinutes += (interval.end - interval.start) / 60_000;
        for (const booking of input.bookings) {
          if (booking.courtId === courtId) bookedCourtMinutes += overlapMinutes(booking.startsAt.getTime(), booking.endsAt.getTime(), interval);
        }
      }
    }
  }
  return {
    availableCourtMinutes,
    bookedCourtMinutes,
    occupancyPercent: availableCourtMinutes === 0 ? 0 : Number((bookedCourtMinutes / availableCourtMinutes * 100).toFixed(2)),
  };
}

export function dateRangeUtc(from: string, to: string): { start: Date; endExclusive: Date } {
  const nextDay = new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start: new Date(localDayStartUtc(from)), endExclusive: new Date(localDayStartUtc(nextDay)) };
}

export async function getVendorAnalytics(prisma: PrismaClient, ownerUserId: string, from: string, to: string) {
  const range = dateRangeUtc(from, to);
  const venueScope = { venue: { vendorProfile: { ownerUserId }, deletedAt: null } } as const;
  const [bookings, courts, payments] = await Promise.all([
    prisma.booking.findMany({
      where: { ...venueScope, startsAt: { lt: range.endExclusive }, endsAt: { gt: range.start }, status: { in: [...SLOT_STATUSES] } },
      select: { id: true, courtId: true, startsAt: true, endsAt: true, status: true, holdExpiresAt: true },
    }),
    prisma.court.findMany({
      where: { isActive: true, venue: { vendorProfile: { ownerUserId }, deletedAt: null } },
      select: {
        id: true, openingTime: true, closingTime: true, availableDays: true,
        blocks: { where: { startsAt: { lt: range.endExclusive }, endsAt: { gt: range.start } }, select: { startsAt: true, endsAt: true } },
      },
    }),
    prisma.payment.findMany({
      where: {
        status: 'SUCCEEDED', settledAt: { gte: range.start, lt: range.endExclusive },
        OR: [
          { booking: { venue: { vendorProfile: { ownerUserId }, deletedAt: null } } },
          { contribution: { bookingParticipant: { booking: { venue: { vendorProfile: { ownerUserId }, deletedAt: null } } } } },
        ],
      }, select: { id: true, amountPaisa: true, method: true, settledAt: true },
    }),
  ]);
  const now = new Date();
  const validBookings = bookings.filter(booking => booking.status !== 'PENDING_PAYMENT' || Boolean(booking.holdExpiresAt && booking.holdExpiresAt > now));
  const bookingCount = validBookings.filter(booking => booking.startsAt >= range.start && booking.startsAt < range.endExclusive).length;
  const occupancy = calculateOccupancy({
    from, to, courtIds: courts.map(court => court.id), courts,
    bookings: validBookings,
  });
  const paidRevenuePaisa = payments.reduce((sum, payment) => sum + payment.amountPaisa, 0);
  const dailyByDate = new Map<string, { date: string; bookingCount: number; paidRevenuePaisa: number }>();
  for (let day = Date.parse(`${from}T00:00:00.000Z`); day <= Date.parse(`${to}T00:00:00.000Z`); day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    dailyByDate.set(date, { date, bookingCount: 0, paidRevenuePaisa: 0 });
  }
  for (const booking of validBookings) {
    if (booking.startsAt < range.start || booking.startsAt >= range.endExclusive) continue;
    const day = dailyByDate.get(pkDateKey(booking.startsAt));
    if (day) day.bookingCount += 1;
  }
  for (const payment of payments) {
    if (!payment.settledAt) continue;
    const day = dailyByDate.get(pkDateKey(payment.settledAt));
    if (day) day.paidRevenuePaisa += payment.amountPaisa;
  }
  return {
    from, to, bookingCount, paidRevenuePaisa,
    paidRevenuePKR: Number((paidRevenuePaisa / 100).toFixed(2)), currency: 'PKR',
    bookedCourtMinutes: Math.round(occupancy.bookedCourtMinutes),
    availableCourtMinutes: Math.round(occupancy.availableCourtMinutes), occupancyPercent: occupancy.occupancyPercent,
    revenueByMethod: {
      onlinePaisa: payments.filter(payment => payment.method === 'ONLINE').reduce((sum, payment) => sum + payment.amountPaisa, 0),
      venuePaisa: payments.filter(payment => payment.method === 'PAY_AT_VENUE').reduce((sum, payment) => sum + payment.amountPaisa, 0),
      bankTransferPaisa: payments.filter(payment => payment.method === 'BANK_TRANSFER').reduce((sum, payment) => sum + payment.amountPaisa, 0),
    },
    daily: [...dailyByDate.values()].map(day => ({
      ...day, paidRevenuePKR: Number((day.paidRevenuePaisa / 100).toFixed(2)),
    })),
  };
}
