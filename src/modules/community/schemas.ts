import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true }).transform(value => new Date(value));

export const roomCreateSchema = z.object({
  sportId: uuid,
  venueId: uuid.optional(),
  courtId: uuid.optional(),
  title: z.string().trim().min(2).max(160),
  locationLabel: z.string().trim().min(2).max(255),
  startsAt: dateTime,
  endsAt: dateTime,
  capacity: z.number().int().min(2).max(50),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
  paymentMode: z.enum(['PAY_AT_VENUE', 'ONLINE', 'BANK_TRANSFER']).default('PAY_AT_VENUE'),
}).superRefine((value, context) => {
  if (value.endsAt <= value.startsAt) context.addIssue({ code: 'custom', path: ['endsAt'], message: 'End time must be after start time.' });
  if (value.startsAt <= new Date()) context.addIssue({ code: 'custom', path: ['startsAt'], message: 'Room start time must be in the future.' });
  if (value.courtId && !value.venueId) context.addIssue({ code: 'custom', path: ['venueId'], message: 'A venue is required when selecting a court.' });
});

export const roomListQuerySchema = z.object({
  sportId: uuid.optional(), city: z.string().trim().min(1).max(100).optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20),
}).refine(value => !value.from || !value.to || value.from <= value.to, { path: ['to'], message: 'End must be on or after start.' });

export const roomJoinSchema = z.object({ inviteCode: z.string().trim().min(20).max(100).optional() });
export const roomMemberParamSchema = z.object({ userId: uuid });
export const messageCreateSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const messageListQuerySchema = z.object({
  before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const tournamentCreateSchema = z.object({
  venueId: uuid, sportId: uuid,
  courtIds: z.array(uuid).min(1).max(50).refine(ids => new Set(ids).size === ids.length, 'Court IDs must be unique.'),
  title: z.string().trim().min(2).max(180), startsAt: dateTime, endsAt: dateTime,
  maxTeams: z.number().int().min(2).max(64), teamSize: z.number().int().min(1).max(50),
  entryFeePerPlayerPaisa: z.number().int().min(0).max(2_000_000_000),
  prizePaisa: z.number().int().min(0).max(2_000_000_000),
}).superRefine((value, context) => {
  if (value.endsAt <= value.startsAt) context.addIssue({ code: 'custom', path: ['endsAt'], message: 'End time must be after start time.' });
  if (value.startsAt <= new Date()) context.addIssue({ code: 'custom', path: ['startsAt'], message: 'Tournament start time must be in the future.' });
});

export const tournamentListQuerySchema = z.object({ sportId: uuid.optional(), status: z.enum(['UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) });
export const tournamentJoinSchema = z.object({ teamName: z.string().trim().min(1).max(120), teamMemberNames: z.array(z.string().trim().min(1).max(100)).max(49).default([]) });
export const standingsSchema = z.object({
  status: z.enum(['ACTIVE', 'COMPLETED']).default('COMPLETED'),
  winnerTeamName: z.string().trim().min(1).max(120).optional(),
  results: z.array(z.object({ participantId: uuid, wins: z.number().int().min(0).max(1000), points: z.number().int().min(0).max(1_000_000) })).min(1).max(64),
}).refine(value => new Set(value.results.map(result => result.participantId)).size === value.results.length, { path: ['results'], message: 'Participant results must be unique.' });
export const tournamentCancelSchema = z.object({ reason: z.string().trim().max(300).optional() }).default({});

export const leaderboardQuerySchema = z.object({ sportId: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
