import { describe, expect, it } from 'vitest';
import { buildSlots, localDateTimeToUtc } from './schedule.js';

describe('venue-local booking schedule', () => {
  it('converts Asia/Karachi wall time to the matching UTC instant without using the host timezone', () => {
    expect(localDateTimeToUtc('2026-11-13', '18:30', 'Asia/Karachi')?.toISOString()).toBe('2026-11-13T13:30:00.000Z');
  });

  it('rejects nonexistent local times during a daylight-saving spring-forward gap', () => {
    expect(localDateTimeToUtc('2026-03-08', '02:30', 'America/New_York')).toBeUndefined();
  });

  it('marks court blocks, active bookings and expired holds while allowing adjacent half-open slots', () => {
    const now = new Date('2026-11-12T23:30:00.000Z');
    const slots = buildSlots({
      date: '2026-11-13', timeZone: 'Asia/Karachi', openingTime: '09:00', closingTime: '12:00',
      slotDurationMinutes: 60, availableDays: ['Fri'], now,
      blocks: [{ startsAt: new Date('2026-11-13T04:00:00.000Z'), endsAt: new Date('2026-11-13T05:00:00.000Z') }],
      bookings: [
        { startsAt: new Date('2026-11-13T05:00:00.000Z'), endsAt: new Date('2026-11-13T06:00:00.000Z'), status: 'CONFIRMED', holdExpiresAt: null },
        { startsAt: new Date('2026-11-13T06:00:00.000Z'), endsAt: new Date('2026-11-13T07:00:00.000Z'), status: 'PENDING_PAYMENT', holdExpiresAt: new Date('2026-11-12T23:00:00.000Z') },
      ],
    });

    expect(slots.map(slot => slot.reason)).toEqual(['BLOCKED', 'BOOKED', 'AVAILABLE']);
    expect(slots[2]?.available).toBe(true);
  });

  it('returns no slots on a closed weekday', () => {
    const slots = buildSlots({
      date: '2026-11-13', timeZone: 'Asia/Karachi', openingTime: '09:00', closingTime: '12:00',
      slotDurationMinutes: 60, availableDays: ['Mon'], now: new Date(), blocks: [], bookings: [],
    });
    expect(slots).toEqual([]);
  });
});
