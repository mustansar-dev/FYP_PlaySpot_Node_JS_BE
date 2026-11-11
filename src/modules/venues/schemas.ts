import { z } from 'zod';

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const coordinate = z.number().finite();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  .or(z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'])
    .transform(value => value.slice(0, 1) + value.slice(1, 3).toLowerCase()));
const nameList = (maxItems: number, maxLength: number) => z.array(z.string().trim().min(1).max(maxLength)).max(maxItems);

const venueFieldsSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(4000).nullable().optional(),
  address: z.string().trim().min(3).max(500),
  city: z.string().trim().min(2).max(100),
  locationNote: nullableText(160),
  latitude: coordinate.min(-90).max(90).nullable().optional(),
  longitude: coordinate.min(-180).max(180).nullable().optional(),
  timeZone: z.string().trim().min(1).max(64).default('Asia/Karachi'),
  sports: nameList(12, 60).min(1),
  facilities: nameList(30, 80).default([]),
  parkingAvailable: z.boolean().default(false),
  parkingSpaces: z.number().int().min(0).max(100_000).default(0),
  published: z.boolean().default(false),
});

export const venueCreateSchema = venueFieldsSchema.superRefine((value, context) => {
  if ((value.latitude == null) !== (value.longitude == null)) {
    context.addIssue({ code: 'custom', path: ['latitude'], message: 'Latitude and longitude must be provided together.' });
  }
  if (value.parkingAvailable === false && value.parkingSpaces !== undefined && value.parkingSpaces !== 0) {
    context.addIssue({ code: 'custom', path: ['parkingSpaces'], message: 'Parking spaces must be zero when parking is unavailable.' });
  }
});

export const venueUpdateSchema = venueFieldsSchema.partial().omit({ sports: true, facilities: true }).extend({
  sports: nameList(12, 60).optional(),
  facilities: nameList(30, 80).optional(),
}).superRefine((value, context) => {
  if ((value.latitude === null) !== (value.longitude === null)) {
    context.addIssue({ code: 'custom', path: ['latitude'], message: 'Latitude and longitude must be cleared or provided together.' });
  }
  if ((value.latitude !== undefined) !== (value.longitude !== undefined)) {
    context.addIssue({ code: 'custom', path: ['latitude'], message: 'Latitude and longitude must be updated together.' });
  }
});

const courtFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sport: z.string().trim().min(1).max(60),
  widthMeters: z.number().positive().max(500),
  lengthMeters: z.number().positive().max(1000),
  indoorOutdoor: z.enum(['INDOOR', 'OUTDOOR']).or(z.enum(['Indoor', 'Outdoor']).transform(value => value.toUpperCase() as 'INDOOR' | 'OUTDOOR')),
  surface: z.string().trim().min(1).max(60),
  conditionRating: z.number().int().min(1).max(5),
  hourlyPricePKR: z.number().int().min(0).max(10_000_000),
  slotDurationMinutes: z.number().int().min(15).max(360),
  openingTime: time.default('09:00'),
  closingTime: time.default('17:00'),
  availableDays: z.array(day).min(1).max(7).default(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']),
});

export const courtCreateSchema = courtFieldsSchema.refine(value => value.openingTime < value.closingTime, {
  path: ['closingTime'], message: 'Closing time must be later than opening time.',
});

export const courtUpdateSchema = courtFieldsSchema.partial().refine(value =>
  value.openingTime === undefined || value.closingTime === undefined || value.openingTime < value.closingTime, {
    path: ['closingTime'], message: 'Closing time must be later than opening time.',
  });

export const equipmentCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sport: z.string().trim().min(1).max(60).nullable().optional(),
  priceMode: z.enum(['RENTAL', 'SALE']),
  unitPricePKR: z.number().int().min(0).max(10_000_000),
  quantityAvailable: z.number().int().min(0).max(1_000_000),
  active: z.boolean().default(true),
});

export const equipmentUpdateSchema = equipmentCreateSchema.partial();

export const mediaUploadSchema = z.object({
  kind: z.enum(['PHOTO', 'VIDEO']),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().toLowerCase().max(120),
  sizeBytes: z.number().int().positive(),
});

export const mediaConfirmSchema = mediaUploadSchema.extend({
  storagePath: z.string().trim().min(1).max(500),
  position: z.number().int().min(0).max(1000).default(0),
});

export const reviewCreateSchema = z.object({
  bookingId: z.string().uuid(),
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().min(8).max(2000),
});

export const reviewUpdateSchema = z.object({
  stars: z.number().int().min(1).max(5).optional(),
  comment: z.string().trim().min(8).max(2000).optional(),
}).refine(value => Object.keys(value).length > 0, 'At least one review field is required.');

export const listVenuesQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  city: z.string().trim().max(100).optional(),
  sport: z.string().trim().max(60).optional(),
  indoorOutdoor: z.enum(['INDOOR', 'OUTDOOR']).or(z.enum(['Indoor', 'Outdoor']).transform(value => value.toUpperCase() as 'INDOOR' | 'OUTDOOR')).optional(),
  amenities: z.string().trim().max(500).optional(),
  minPricePKR: z.coerce.number().int().min(0).optional(),
  maxPricePKR: z.coerce.number().int().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  sort: z.enum(['rating', 'price', 'name', 'newest']).default('rating'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).refine(value => value.minPricePKR === undefined || value.maxPricePKR === undefined || value.minPricePKR <= value.maxPricePKR, {
  path: ['maxPricePKR'], message: 'Maximum price must be at least the minimum price.',
});

export const nearbyVenuesQuerySchema = listVenuesQuerySchema.extend({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(200).default(25),
});

export type VenueCreateInput = z.infer<typeof venueCreateSchema>;
export type CourtInput = z.infer<typeof courtCreateSchema>;
