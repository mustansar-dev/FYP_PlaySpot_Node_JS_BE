import { z } from 'zod';

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const date = z.string().refine(validDate, 'Use a valid calendar date in YYYY-MM-DD format.');

export const analyticsQuerySchema = z.object({ from: date, to: date }).superRefine((value, context) => {
  if (value.from > value.to) context.addIssue({ code: 'custom', path: ['to'], message: 'End date must be on or after start date.' });
  if (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`) > 366 * 86_400_000) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'The requested range cannot exceed 367 calendar days.' });
  }
});
