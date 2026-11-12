const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export interface LocalSlot {
  date: string;
  startTime: string;
  endTime: string;
  startsAt: Date;
  endsAt: Date;
}

function dateParts(dateKey: string): [number, number, number] | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return undefined;
  return [year, month, day];
}

export function isValidDateKey(dateKey: string): boolean {
  return dateParts(dateKey) !== undefined;
}

export function timeToMinutes(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

export function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function weekdayForDate(dateKey: string): string | undefined {
  const parts = dateParts(dateKey);
  if (!parts) return undefined;
  const [year, month, day] = parts;
  return DAY_NAMES[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

function formattedParts(formatter: Intl.DateTimeFormat, instant: Date): [number, number, number, number, number, number] {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
  return [
    Number(parts.year), Number(parts.month), Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  ];
}

export function utcInstantToLocal(instant: Date, timeZone: string): { date: string; time: string } | undefined {
  try {
    const [year, month, day, hour, minute] = formattedParts(formatterFor(timeZone), instant);
    return {
      date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  } catch {
    return undefined;
  }
}

/** Convert a venue-local date/time to a UTC instant without relying on the host machine timezone. */
export function localDateTimeToUtc(dateKey: string, time: string, timeZone: string): Date | undefined {
  const date = dateParts(dateKey);
  const minuteOfDay = timeToMinutes(time);
  if (!date || minuteOfDay === undefined) return undefined;
  const [year, month, day] = date;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const desiredWallClock = Date.UTC(year, month - 1, day, hour, minute);

  try {
    const formatter = formatterFor(timeZone);
    let candidate = desiredWallClock;
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const [localYear, localMonth, localDay, localHour, localMinute, localSecond] = formattedParts(formatter, new Date(candidate));
      const representedWallClock = Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, localSecond);
      candidate += desiredWallClock - representedWallClock;
    }
    const result = new Date(candidate);
    const [localYear, localMonth, localDay, localHour, localMinute, localSecond] = formattedParts(formatter, result);
    if (localYear !== year || localMonth !== month || localDay !== day || localHour !== hour || localMinute !== minute || localSecond !== 0) return undefined;
    return result;
  } catch {
    return undefined;
  }
}

export function localDayBounds(dateKey: string, timeZone: string): { startsAt: Date; endsAt: Date } | undefined {
  const parts = dateParts(dateKey);
  if (!parts) return undefined;
  const [year, month, day] = parts;
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDateKey = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDate.getUTCDate()).padStart(2, '0')}`;
  const startsAt = localDateTimeToUtc(dateKey, '00:00', timeZone);
  const endsAt = localDateTimeToUtc(nextDateKey, '00:00', timeZone);
  return startsAt && endsAt ? { startsAt, endsAt } : undefined;
}

export function overlaps(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return startA.getTime() < endB.getTime() && startB.getTime() < endA.getTime();
}

export function buildSlots(input: {
  date: string;
  timeZone: string;
  openingTime: string;
  closingTime: string;
  slotDurationMinutes: number;
  availableDays: string[];
  now: Date;
  blocks: Array<{ startsAt: Date; endsAt: Date }>;
  bookings: Array<{ startsAt: Date; endsAt: Date; status: string; holdExpiresAt: Date | null }>;
}): Array<LocalSlot & { available: boolean; reason: 'AVAILABLE' | 'PAST' | 'BLOCKED' | 'BOOKED' | 'HELD' }> {
  const opening = timeToMinutes(input.openingTime);
  const closing = timeToMinutes(input.closingTime);
  const weekday = weekdayForDate(input.date);
  if (opening === undefined || closing === undefined || closing <= opening || !weekday || !input.availableDays.includes(weekday)) return [];

  const slots: Array<LocalSlot & { available: boolean; reason: 'AVAILABLE' | 'PAST' | 'BLOCKED' | 'BOOKED' | 'HELD' }> = [];
  for (let startMinute = opening; startMinute + input.slotDurationMinutes <= closing; startMinute += input.slotDurationMinutes) {
    const endMinute = startMinute + input.slotDurationMinutes;
    const startTime = minutesToTime(startMinute);
    const endTime = minutesToTime(endMinute);
    const startsAt = localDateTimeToUtc(input.date, startTime, input.timeZone);
    const endsAt = localDateTimeToUtc(input.date, endTime, input.timeZone);
    if (!startsAt || !endsAt) continue;

    let reason: 'AVAILABLE' | 'PAST' | 'BLOCKED' | 'BOOKED' | 'HELD' = 'AVAILABLE';
    if (startsAt <= input.now) reason = 'PAST';
    else if (input.blocks.some(block => overlaps(startsAt, endsAt, block.startsAt, block.endsAt))) reason = 'BLOCKED';
    else {
      const booking = input.bookings.find(record => overlaps(startsAt, endsAt, record.startsAt, record.endsAt)
        && (record.status !== 'PENDING_PAYMENT' || (record.holdExpiresAt !== null && record.holdExpiresAt > input.now)));
      if (booking) reason = booking.status === 'PENDING_PAYMENT' ? 'HELD' : 'BOOKED';
    }
    slots.push({ date: input.date, startTime, endTime, startsAt, endsAt, available: reason === 'AVAILABLE', reason });
  }
  return slots;
}
