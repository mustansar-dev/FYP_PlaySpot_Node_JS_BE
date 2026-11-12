import { z } from 'zod';
import { isValidDateKey, timeToMinutes } from './schedule.js';

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidDateKey, 'Date must be a real calendar date.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const bookingFields = z.object({
  courtId: z.string().uuid(),
  date: dateKey,
  startTime: time,
  endTime: time,
  addOns: z.array(z.object({ equipmentId: z.string().uuid(), quantity: z.number().int().min(1).max(100) })).max(50).default([]),
}).superRefine((value, context) => {
  const start = timeToMinutes(value.startTime);
  const end = timeToMinutes(value.endTime);
  if (start === undefined || end === undefined || end <= start) {
    context.addIssue({ code: 'custom', path: ['endTime'], message: 'End time must be later than start time.' });
  }
  if (new Set(value.addOns.map(item => item.equipmentId)).size !== value.addOns.length) {
    context.addIssue({ code: 'custom', path: ['addOns'], message: 'Each add-on may appear only once.' });
  }
});

export const availabilityQuerySchema = z.object({ date: dateKey });

export const bookingCreateSchema = bookingFields.extend({
  paymentMode: z.enum(['ONLINE', 'PAY_AT_VENUE', 'BANK_TRANSFER']).default('ONLINE'),
  participantUserIds: z.array(z.string().uuid()).max(19).default([]),
});

export const walkInCreateSchema = bookingFields.extend({
  customerName: z.string().trim().min(1).max(120),
  customerPhone: z.string().trim().max(32).optional(),
});

export const bookingListQuerySchema = z.object({
  from: dateKey.optional(),
  to: dateKey.optional(),
  courtId: z.string().uuid().optional(),
  status: z.enum(['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'EXPIRED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).refine(value => value.from === undefined || value.to === undefined || value.from <= value.to, {
  path: ['to'], message: 'End date must be on or after start date.',
});

export const bookingCancelSchema = z.object({
  reason: z.string().trim().max(300).optional(),
}).default({});

export type BookingCreateInput = z.infer<typeof bookingCreateSchema>;
export type WalkInCreateInput = z.infer<typeof walkInCreateSchema>;
