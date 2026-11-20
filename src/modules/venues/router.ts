import { Router, type Request, type Response } from 'express';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { apiError, apiSuccess } from '../../common/apiResponse.js';
import { HttpError } from '../../common/httpError.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { findNearbyVenueIds, setVenuePoint } from './spatialRepository.js';
import {
  courtCreateSchema, courtUpdateSchema, equipmentCreateSchema, equipmentUpdateSchema,
  listVenuesQuerySchema, mediaConfirmSchema, mediaUploadSchema, nearbyVenuesQuerySchema,
  reviewCreateSchema, reviewUpdateSchema, venueCreateSchema, venueUpdateSchema,
} from './schemas.js';
import { UnconfiguredVenueStorage, validateMedia, type VenueStorage } from './storage.js';

export interface VenueRouterOptions {
  prisma: PrismaClient;
  accessSecret: string;
  storage?: VenueStorage;
}

const venueInclude = {
  sports: { include: { sport: { select: { id: true, code: true, name: true } } } },
  amenities: { include: { amenity: { select: { id: true, name: true } } } },
  media: { orderBy: [{ position: 'asc' as const }, { createdAt: 'asc' as const }] },
  courts: { where: { isActive: true }, include: { sport: { select: { id: true, code: true, name: true } } }, orderBy: { name: 'asc' as const } },
  equipment: { where: { active: true }, include: { sport: { select: { id: true, code: true, name: true } } }, orderBy: { name: 'asc' as const } },
  _count: { select: { reviews: true } },
} satisfies Prisma.VenueInclude;
type VenueRecord = Prisma.VenueGetPayload<{ include: typeof venueInclude }>;

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

function ratingDto(value?: { _avg: { stars: number | null }; _count: { _all: number } }) {
  return { ratingAverage: value?._avg.stars ?? 0, ratingCount: value?._count._all ?? 0 };
}

function venueDto(
  venue: VenueRecord,
  rating?: { _avg: { stars: number | null }; _count: { _all: number } },
  distanceKm?: number,
  storage?: VenueStorage,
) {
  const minPricePaisa = venue.courts.reduce<number | null>((min, court) => min === null ? court.hourlyPricePaisa : Math.min(min, court.hourlyPricePaisa), null);
  return {
    id: venue.id,
    name: venue.name,
    description: venue.description,
    address: venue.address,
    city: venue.city,
    locationNote: venue.locationNote,
    latitude: venue.latitude,
    longitude: venue.longitude,
    timeZone: venue.timeZone,
    sports: venue.sports.map(item => item.sport.name),
    facilities: venue.amenities.map(item => item.amenity.name),
    parkingAvailable: venue.parkingAvailable,
    parkingSpaces: venue.parkingSpaces,
    published: venue.published,
    media: venue.media.map(item => ({
      id: item.id, kind: item.kind, storagePath: item.storagePath,
      url: storage ? storage.publicUrl(item.storagePath) : null,
      fileName: item.fileName, mimeType: item.mimeType, sizeBytes: item.sizeBytes, position: item.position,
    })),
    grounds: venue.courts.map(court => ({
      id: court.id, venueId: court.venueId, name: court.name, sport: court.sport.name,
      widthMeters: Number(court.widthMeters), lengthMeters: Number(court.lengthMeters),
      indoorOutdoor: court.indoorOutdoor === 'INDOOR' ? 'Indoor' : 'Outdoor',
      surface: court.surface, conditionRating: court.conditionRating,
      hourlyPricePKR: court.hourlyPricePaisa / 100, slotDurationMinutes: court.slotDurationMinutes,
      openingTime: court.openingTime, closingTime: court.closingTime, availableDays: court.availableDays,
      isActive: court.isActive,
    })),
    equipment: venue.equipment.map(item => ({
      id: item.id, venueId: item.venueId, name: item.name, sport: item.sport?.name ?? null,
      priceMode: item.priceMode.toLowerCase(), unitPricePKR: item.unitPricePaisa / 100,
      quantityAvailable: item.quantityAvailable, active: item.active,
    })),
    ...ratingDto(rating),
    minimumHourlyPricePKR: minPricePaisa === null ? null : minPricePaisa / 100,
    ...(distanceKm === undefined ? {} : { distanceKm }),
  };
}

async function ratingsFor(prisma: PrismaClient, venueIds: string[]) {
  if (!venueIds.length) return new Map<string, { _avg: { stars: number | null }; _count: { _all: number } }>();
  const groups = await prisma.review.groupBy({
    by: ['venueId'], where: { venueId: { in: venueIds } },
    _avg: { stars: true }, _count: { _all: true },
  });
  return new Map(groups.map(item => [item.venueId, { _avg: item._avg, _count: item._count }]));
}

function safeFileName(name: string): string {
  return name.replace(/[\\/]/g, '_').split('').filter(character => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }).join('').slice(0, 255);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export function createVenueRouter({ prisma, accessSecret, storage = new UnconfiguredVenueStorage() }: VenueRouterOptions): Router {
  const router = Router();
  const authenticate = requireAuth(prisma, accessSecret);
  const vendorOnly = requireRole('VENDOR');

  // Public reference catalog required by room and tournament forms, which use sport UUIDs.
  router.get('/sports', async (_request, response, next) => {
    try {
      const items = await prisma.sport.findMany({
        where: { isActive: true }, orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true },
      });
      if (!items.length) {
        throw new HttpError(503, 'SPORT_CATALOG_NOT_SEEDED', 'Sports are not initialized in this database. Run `npm run setup` in the backend project.');
      }
      response.status(200).json(apiSuccess(items));
    } catch (error) { next(error); }
  });

  async function vendorProfile(ownerUserId: string) {
    const profile = await prisma.vendorProfile.findUnique({
      where: { ownerUserId }, select: { id: true, verificationStatus: true },
    });
    if (!profile) throw new HttpError(404, 'VENDOR_PROFILE_NOT_FOUND', 'The vendor profile was not found.');
    return profile;
  }

  async function ownedVenue(venueId: string, ownerUserId: string) {
    const venue = await prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null, vendorProfile: { ownerUserId } },
      select: { id: true, vendorProfileId: true, published: true },
    });
    if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
    return venue;
  }

  async function resolveSports(tx: Prisma.TransactionClient, values: string[]) {
    const normalized = [...new Set(values.map(value => value.trim()))];
    const found = await tx.sport.findMany({
      where: { isActive: true, OR: normalized.flatMap(value => [
        { code: { equals: value, mode: 'insensitive' } }, { name: { equals: value, mode: 'insensitive' } },
      ]) }, select: { id: true, code: true, name: true },
    });
    const requested = new Set(normalized.map(value => value.toLowerCase()));
    const matched = new Set(found.flatMap(item => [item.code.toLowerCase(), item.name.toLowerCase()]));
    if ([...requested].some(value => !matched.has(value))) {
      throw new HttpError(400, 'INVALID_SPORT', 'One or more sports are not in the active sports catalog.');
    }
    return found;
  }

  async function resolveAmenities(tx: Prisma.TransactionClient, values: string[]) {
    const normalized = [...new Map(values.map(value => [value.trim().toLowerCase(), value.trim()])).values()];
    const existing = await tx.amenity.findMany({
      where: { isActive: true, OR: normalized.map(name => ({ name: { equals: name, mode: 'insensitive' as const } })) },
      select: { id: true, name: true },
    });
    const foundNames = new Set(existing.map(item => item.name.toLowerCase()));
    const missing = normalized.filter(name => !foundNames.has(name.toLowerCase()));
    const created = await Promise.all(missing.map(name => tx.amenity.upsert({
      where: { name }, update: { isActive: true }, create: { name }, select: { id: true, name: true },
    })));
    return [...existing, ...created];
  }

  async function venueSportId(tx: Prisma.TransactionClient, venueId: string, value: string): Promise<string> {
    const sport = (await resolveSports(tx, [value]))[0]!;
    const offered = await tx.venueSport.findUnique({ where: { venueId_sportId: { venueId, sportId: sport.id } }, select: { sportId: true } });
    if (!offered) throw new HttpError(400, 'SPORT_NOT_OFFERED', 'This venue does not list the selected sport.');
    return sport.id;
  }

  async function mapVenues(
    venues: VenueRecord[],
    distances?: Map<string, number>,
    knownRatings?: Map<string, { _avg: { stars: number | null }; _count: { _all: number } }>,
  ) {
    const ratings = knownRatings ?? await ratingsFor(prisma, venues.map(item => item.id));
    return venues.map(item => venueDto(item, ratings.get(item.id), distances?.get(item.id), storage));
  }

  // Public amenities are reference labels used by the vendor form.
  router.get('/amenities', async (_request, response, next) => {
    try {
      const items = await prisma.amenity.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
      response.status(200).json(apiSuccess(items));
    } catch (error) { next(error); }
  });

  // List all public venues. Every selected amenity is required (AND semantics).
  router.get('/venues', async (request, response, next) => {
    const parsed = listVenuesQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const query = parsed.data;
      const amenityNames = query.amenities ? [...new Set(query.amenities.split(',').map(value => value.trim()).filter(Boolean))] : [];
      const courtWhere: Prisma.CourtWhereInput = {
        isActive: true,
        ...(query.indoorOutdoor ? { indoorOutdoor: query.indoorOutdoor } : {}),
        ...(query.minPricePKR !== undefined || query.maxPricePKR !== undefined ? { hourlyPricePaisa: {
          ...(query.minPricePKR !== undefined ? { gte: query.minPricePKR * 100 } : {}),
          ...(query.maxPricePKR !== undefined ? { lte: query.maxPricePKR * 100 } : {}),
        } } : {}),
      };
      const where: Prisma.VenueWhereInput = {
        deletedAt: null, published: true,
        ...(query.q ? { OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { address: { contains: query.q, mode: 'insensitive' } },
          { city: { contains: query.q, mode: 'insensitive' } },
        ] } : {}),
        ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}),
        ...(query.sport ? { sports: { some: { sport: { OR: [
          { code: { equals: query.sport, mode: 'insensitive' } },
          { name: { equals: query.sport, mode: 'insensitive' } },
        ] } } } } : {}),
        ...(amenityNames.length ? { AND: amenityNames.map(name => ({
          amenities: { some: { amenity: { name: { equals: name, mode: 'insensitive' } } } },
        })) } : {}),
        ...(query.indoorOutdoor || query.minPricePKR !== undefined || query.maxPricePKR !== undefined ? { courts: { some: courtWhere } } : {}),
      };
      const allIdsForRating = query.minRating !== undefined || query.sort === 'rating' || query.sort === 'price'
        ? await prisma.venue.findMany({
          where, select: { id: true },
          ...(query.sort === 'name' ? { orderBy: { name: 'asc' } } : query.sort === 'newest' ? { orderBy: { createdAt: 'desc' } } : {}),
        }) : undefined;
      const allRatings = allIdsForRating ? await ratingsFor(prisma, allIdsForRating.map(item => item.id)) : undefined;
      const prices = allIdsForRating && query.sort === 'price' ? await prisma.court.groupBy({
        by: ['venueId'], where: { venueId: { in: allIdsForRating.map(item => item.id) }, isActive: true },
        _min: { hourlyPricePaisa: true },
      }) : undefined;
      const minPrices = prices ? new Map(prices.map(item => [item.venueId, item._min.hourlyPricePaisa])) : undefined;
      const filteredIds = allIdsForRating?.map(item => item.id).filter(id => {
        const count = allRatings?.get(id)?._count._all ?? 0;
        const average = allRatings?.get(id)?._avg.stars ?? 0;
        return (query.minRating === undefined || (average >= query.minRating && (count > 0 || query.minRating === 0)));
      });
      if (query.sort === 'rating' && filteredIds && allRatings) {
        filteredIds.sort((a, b) => (allRatings.get(b)?._avg.stars ?? 0) - (allRatings.get(a)?._avg.stars ?? 0) || a.localeCompare(b));
      }
      if (query.sort === 'price' && filteredIds && minPrices) {
        filteredIds.sort((a, b) => (minPrices.get(a) ?? Number.MAX_SAFE_INTEGER) - (minPrices.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
      }
      const total = filteredIds?.length ?? await prisma.venue.count({ where });
      const skip = (query.page - 1) * query.limit;
      const idsPage = filteredIds?.slice(skip, skip + query.limit);
      let venues = await prisma.venue.findMany({
        where: { ...where, ...(idsPage ? { id: { in: idsPage } } : {}) }, include: venueInclude,
        ...(filteredIds ? {} : { skip, take: query.limit }),
        ...(query.sort === 'name' ? { orderBy: { name: 'asc' } } : query.sort === 'newest' ? { orderBy: { createdAt: 'desc' } } : {}),
      });
      if (idsPage) {
        const byId = new Map(venues.map(item => [item.id, item]));
        venues = idsPage.map(id => byId.get(id)).filter((item): item is VenueRecord => item !== undefined);
      }
      response.status(200).json(apiSuccess(await mapVenues(venues, undefined, allRatings), { page: query.page, limit: query.limit, total }));
    } catch (error) { next(error); }
  });

  // Nearby filtering and distance ordering are performed by PostGIS, not in Node.
  router.get('/venues/nearby', async (request, response, next) => {
    const parsed = nearbyVenuesQuerySchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const { lat, lng, radiusKm, page, limit, q, city, sport, amenities, indoorOutdoor, minPricePKR, maxPricePKR, minRating } = parsed.data;
      const amenityNames = amenities ? [...new Set(amenities.split(',').map(value => value.trim()).filter(Boolean))] : [];
      const { rows, total } = await findNearbyVenueIds(prisma, {
        latitude: lat, longitude: lng, radiusMeters: radiusKm * 1000,
        offset: (page - 1) * limit, limit,
        ...(q ? { q } : {}), ...(city ? { city } : {}), ...(sport ? { sport } : {}),
        ...(amenityNames.length ? { amenities: amenityNames } : {}),
        ...(indoorOutdoor ? { indoorOutdoor } : {}),
        ...(minPricePKR !== undefined ? { minPricePaisa: minPricePKR * 100 } : {}),
        ...(maxPricePKR !== undefined ? { maxPricePaisa: maxPricePKR * 100 } : {}),
        ...(minRating !== undefined ? { minRating } : {}),
      });
      const distances = new Map(rows.map(item => [item.id, item.distance_m / 1000]));
      const items = rows.length ? await prisma.venue.findMany({
        where: { id: { in: rows.map(item => item.id) }, deletedAt: null, published: true }, include: venueInclude,
      }) : [];
      const byId = new Map(items.map(item => [item.id, item]));
      const ordered = rows.map(item => byId.get(item.id)).filter((item): item is VenueRecord => item !== undefined);
      response.status(200).json(apiSuccess(await mapVenues(ordered, distances), { page, limit, total }));
    } catch (error) { next(error); }
  });

  // Public detail only exposes published, non-deleted venues.
  router.get('/venues/:venueId', async (request, response, next) => {
    try {
      const id = routeId(request, 'venueId');
      const venue = await prisma.venue.findFirst({ where: { id, published: true, deletedAt: null }, include: venueInclude });
      if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
      const ratings = await ratingsFor(prisma, [id]);
      response.status(200).json(apiSuccess(venueDto(venue, ratings.get(id), undefined, storage)));
    } catch (error) { next(error); }
  });

  // Vendor's private management list includes drafts.
  router.get('/vendors/me/venues', authenticate, vendorOnly, async (request, response, next) => {
    try {
      const profile = await vendorProfile(request.auth!.userId);
      const venues = await prisma.venue.findMany({ where: { vendorProfileId: profile.id, deletedAt: null }, include: venueInclude, orderBy: { createdAt: 'desc' } });
      response.status(200).json(apiSuccess(await mapVenues(venues)));
    } catch (error) { next(error); }
  });

  router.post('/venues', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = venueCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const input = parsed.data;
      const profile = await vendorProfile(request.auth!.userId);
      if (input.published && profile.verificationStatus !== 'APPROVED') {
        throw new HttpError(403, 'VENDOR_NOT_APPROVED', 'The vendor profile must be approved before publishing a venue.');
      }
      const venue = await prisma.$transaction(async tx => {
        const sports = await resolveSports(tx, input.sports);
        const amenities = await resolveAmenities(tx, input.facilities);
        const created = await tx.venue.create({ data: {
          vendorProfileId: profile.id, name: input.name, description: input.description ?? null,
          address: input.address, city: input.city, locationNote: input.locationNote ?? null,
          latitude: input.latitude ?? null, longitude: input.longitude ?? null, timeZone: input.timeZone,
          parkingAvailable: input.parkingAvailable, parkingSpaces: input.parkingSpaces, published: input.published,
          sports: { create: sports.map(sport => ({ sportId: sport.id })) },
          amenities: { create: amenities.map(amenity => ({ amenityId: amenity.id })) },
        }, include: venueInclude });
        await setVenuePoint(tx, created.id, input.latitude ?? null, input.longitude ?? null);
        return created;
      });
      response.status(201).json(apiSuccess(venueDto(venue, undefined, undefined, storage)));
    } catch (error) { next(error); }
  });

  router.patch('/venues/:venueId', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = venueUpdateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const id = routeId(request, 'venueId');
      await ownedVenue(id, request.auth!.userId);
      const profile = await vendorProfile(request.auth!.userId);
      if (parsed.data.published === true && profile.verificationStatus !== 'APPROVED') {
        throw new HttpError(403, 'VENDOR_NOT_APPROVED', 'The vendor profile must be approved before publishing a venue.');
      }
      const input = parsed.data;
      const updated = await prisma.$transaction(async tx => {
        if (input.sports) {
          const sports = await resolveSports(tx, input.sports);
          await tx.venueSport.deleteMany({ where: { venueId: id } });
          if (sports.length) await tx.venueSport.createMany({ data: sports.map(sport => ({ venueId: id, sportId: sport.id })) });
        }
        if (input.facilities) {
          const amenities = await resolveAmenities(tx, input.facilities);
          await tx.venueAmenity.deleteMany({ where: { venueId: id } });
          if (amenities.length) await tx.venueAmenity.createMany({ data: amenities.map(amenity => ({ venueId: id, amenityId: amenity.id })) });
        }
        const { sports: _sports, facilities: _facilities, latitude, longitude } = input;
        void _sports; void _facilities;
        const coordinatesChanged = latitude !== undefined && longitude !== undefined;
        const data: Prisma.VenueUpdateInput = {};
        if (input.name !== undefined) data.name = input.name;
        if (input.description !== undefined) data.description = input.description;
        if (input.address !== undefined) data.address = input.address;
        if (input.city !== undefined) data.city = input.city;
        if (input.locationNote !== undefined) data.locationNote = input.locationNote;
        if (input.timeZone !== undefined) data.timeZone = input.timeZone;
        if (input.parkingAvailable !== undefined) {
          data.parkingAvailable = input.parkingAvailable;
          if (!input.parkingAvailable) data.parkingSpaces = 0;
        }
        if (input.parkingSpaces !== undefined) data.parkingSpaces = input.parkingSpaces;
        if (input.published !== undefined) data.published = input.published;
        if (coordinatesChanged) { data.latitude = latitude ?? null; data.longitude = longitude ?? null; }
        const result = await tx.venue.update({ where: { id }, data: {
          ...data,
        }, include: venueInclude });
        if (coordinatesChanged) await setVenuePoint(tx, id, latitude ?? null, longitude ?? null);
        return result;
      });
      response.status(200).json(apiSuccess(venueDto(updated, undefined, undefined, storage)));
    } catch (error) { next(error); }
  });

  router.delete('/venues/:venueId', authenticate, vendorOnly, async (request, response, next) => {
    try {
      const id = routeId(request, 'venueId');
      await ownedVenue(id, request.auth!.userId);
      await prisma.venue.update({ where: { id }, data: { deletedAt: new Date(), published: false } });
      response.status(200).json(apiSuccess({ deleted: true }));
    } catch (error) { next(error); }
  });

  router.get('/venues/:venueId/courts', async (request, response, next) => {
    try {
      const id = routeId(request, 'venueId');
      const venue = await prisma.venue.findFirst({ where: { id, published: true, deletedAt: null }, select: { id: true } });
      if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
      const courts = await prisma.court.findMany({ where: { venueId: id, isActive: true }, include: { sport: { select: { code: true, name: true } } }, orderBy: { name: 'asc' } });
      response.status(200).json(apiSuccess(courts.map(court => ({
        id: court.id, venueId: court.venueId, name: court.name, sport: court.sport.name,
        widthMeters: Number(court.widthMeters), lengthMeters: Number(court.lengthMeters),
        indoorOutdoor: court.indoorOutdoor === 'INDOOR' ? 'Indoor' : 'Outdoor', surface: court.surface,
        conditionRating: court.conditionRating, hourlyPricePKR: court.hourlyPricePaisa / 100,
        slotDurationMinutes: court.slotDurationMinutes, openingTime: court.openingTime,
        closingTime: court.closingTime, availableDays: court.availableDays,
      }))));
    } catch (error) { next(error); }
  });

  router.post('/venues/:venueId/courts', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = courtCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const venueId = routeId(request, 'venueId');
      await ownedVenue(venueId, request.auth!.userId);
      const input = parsed.data;
      const court = await prisma.$transaction(async tx => {
        const sportId = await venueSportId(tx, venueId, input.sport);
        return tx.court.create({ data: {
          venueId, sportId, name: input.name,
          widthMeters: input.widthMeters, lengthMeters: input.lengthMeters,
          indoorOutdoor: input.indoorOutdoor, surface: input.surface, conditionRating: input.conditionRating,
          hourlyPricePaisa: input.hourlyPricePKR * 100, slotDurationMinutes: input.slotDurationMinutes,
          openingTime: input.openingTime, closingTime: input.closingTime, availableDays: input.availableDays,
        }, include: { sport: { select: { name: true } } } });
      });
      response.status(201).json(apiSuccess({
        id: court.id, venueId, name: court.name, sport: court.sport.name,
        widthMeters: Number(court.widthMeters), lengthMeters: Number(court.lengthMeters),
        indoorOutdoor: court.indoorOutdoor === 'INDOOR' ? 'Indoor' : 'Outdoor', surface: court.surface,
        conditionRating: court.conditionRating, hourlyPricePKR: court.hourlyPricePaisa / 100,
        slotDurationMinutes: court.slotDurationMinutes, openingTime: court.openingTime,
        closingTime: court.closingTime, availableDays: court.availableDays,
      }));
    } catch (error) { next(error); }
  });

  router.patch('/venues/:venueId/courts/:courtId', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = courtUpdateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const venueId = routeId(request, 'venueId');
      const courtId = routeId(request, 'courtId');
      await ownedVenue(venueId, request.auth!.userId);
      const input = parsed.data;
      const result = await prisma.$transaction(async tx => {
        const current = await tx.court.findFirst({ where: { id: courtId, venueId, isActive: true }, select: { id: true, openingTime: true, closingTime: true } });
        if (!current) throw new HttpError(404, 'COURT_NOT_FOUND', 'The court was not found.');
        const nextOpeningTime = input.openingTime ?? current.openingTime;
        const nextClosingTime = input.closingTime ?? current.closingTime;
        if (nextOpeningTime >= nextClosingTime) {
          throw new HttpError(400, 'INVALID_OPERATING_HOURS', 'Closing time must be later than opening time.');
        }
        const { sport: sportName, hourlyPricePKR } = input;
        const nextSportId = sportName ? await venueSportId(tx, venueId, sportName) : undefined;
        const data: Prisma.CourtUpdateInput = {};
        if (input.name !== undefined) data.name = input.name;
        if (input.widthMeters !== undefined) data.widthMeters = input.widthMeters;
        if (input.lengthMeters !== undefined) data.lengthMeters = input.lengthMeters;
        if (input.indoorOutdoor !== undefined) data.indoorOutdoor = input.indoorOutdoor;
        if (input.surface !== undefined) data.surface = input.surface;
        if (input.conditionRating !== undefined) data.conditionRating = input.conditionRating;
        if (input.slotDurationMinutes !== undefined) data.slotDurationMinutes = input.slotDurationMinutes;
        if (input.openingTime !== undefined) data.openingTime = input.openingTime;
        if (input.closingTime !== undefined) data.closingTime = input.closingTime;
        if (input.availableDays !== undefined) data.availableDays = input.availableDays;
        if (nextSportId) data.sport = { connect: { id: nextSportId } };
        if (hourlyPricePKR !== undefined) data.hourlyPricePaisa = hourlyPricePKR * 100;
        return tx.court.update({ where: { id: courtId }, data: {
          ...data,
        }, include: { sport: { select: { name: true } } } });
      });
      response.status(200).json(apiSuccess({
        id: result.id, venueId, name: result.name, sport: result.sport.name,
        widthMeters: Number(result.widthMeters), lengthMeters: Number(result.lengthMeters),
        indoorOutdoor: result.indoorOutdoor === 'INDOOR' ? 'Indoor' : 'Outdoor', surface: result.surface,
        conditionRating: result.conditionRating, hourlyPricePKR: result.hourlyPricePaisa / 100,
        slotDurationMinutes: result.slotDurationMinutes, openingTime: result.openingTime,
        closingTime: result.closingTime, availableDays: result.availableDays,
      }));
    } catch (error) { next(error); }
  });

  router.delete('/venues/:venueId/courts/:courtId', authenticate, vendorOnly, async (request, response, next) => {
    try {
      const venueId = routeId(request, 'venueId');
      const courtId = routeId(request, 'courtId');
      await ownedVenue(venueId, request.auth!.userId);
      const updated = await prisma.court.updateMany({ where: { id: courtId, venueId, isActive: true }, data: { isActive: false } });
      if (!updated.count) throw new HttpError(404, 'COURT_NOT_FOUND', 'The court was not found.');
      response.status(200).json(apiSuccess({ deleted: true }));
    } catch (error) { next(error); }
  });

  router.get('/venues/:venueId/equipment', async (request, response, next) => {
    try {
      const venueId = routeId(request, 'venueId');
      const venue = await prisma.venue.findFirst({ where: { id: venueId, published: true, deletedAt: null }, select: { id: true } });
      if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
      const items = await prisma.equipmentItem.findMany({ where: { venueId, active: true }, include: { sport: { select: { name: true } } }, orderBy: { name: 'asc' } });
      response.status(200).json(apiSuccess(items.map(item => ({
        id: item.id, venueId: item.venueId, name: item.name, sport: item.sport?.name ?? null,
        priceMode: item.priceMode.toLowerCase(), unitPricePKR: item.unitPricePaisa / 100,
        quantityAvailable: item.quantityAvailable, active: item.active,
      }))));
    } catch (error) { next(error); }
  });

  router.post('/venues/:venueId/equipment', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = equipmentCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const venueId = routeId(request, 'venueId');
      await ownedVenue(venueId, request.auth!.userId);
      const input = parsed.data;
      const item = await prisma.$transaction(async tx => {
        const sportId = input.sport ? await venueSportId(tx, venueId, input.sport) : undefined;
        return tx.equipmentItem.create({ data: {
          venueId, sportId: sportId ?? null, name: input.name, priceMode: input.priceMode,
          unitPricePaisa: input.unitPricePKR * 100, quantityAvailable: input.quantityAvailable, active: input.active,
        }, include: { sport: { select: { name: true } } } });
      });
      response.status(201).json(apiSuccess({
        id: item.id, venueId, name: item.name, sport: item.sport?.name ?? null,
        priceMode: item.priceMode.toLowerCase(), unitPricePKR: item.unitPricePaisa / 100,
        quantityAvailable: item.quantityAvailable, active: item.active,
      }));
    } catch (error) { next(error); }
  });

  router.patch('/venues/:venueId/equipment/:equipmentId', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = equipmentUpdateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const venueId = routeId(request, 'venueId');
      const equipmentId = routeId(request, 'equipmentId');
      await ownedVenue(venueId, request.auth!.userId);
      const input = parsed.data;
      const item = await prisma.$transaction(async tx => {
        const current = await tx.equipmentItem.findFirst({ where: { id: equipmentId, venueId }, select: { id: true } });
        if (!current) throw new HttpError(404, 'EQUIPMENT_NOT_FOUND', 'The equipment item was not found.');
        const { sport: sportName, unitPricePKR } = input;
        const sportId = sportName ? await venueSportId(tx, venueId, sportName) : undefined;
        const data: Prisma.EquipmentItemUpdateInput = {};
        if (input.name !== undefined) data.name = input.name;
        if (input.priceMode !== undefined) data.priceMode = input.priceMode;
        if (input.quantityAvailable !== undefined) data.quantityAvailable = input.quantityAvailable;
        if (input.active !== undefined) data.active = input.active;
        if (sportName !== undefined) data.sport = sportId ? { connect: { id: sportId } } : { disconnect: true };
        if (unitPricePKR !== undefined) data.unitPricePaisa = unitPricePKR * 100;
        return tx.equipmentItem.update({ where: { id: equipmentId }, data: {
          ...data,
        }, include: { sport: { select: { name: true } } } });
      });
      response.status(200).json(apiSuccess({
        id: item.id, venueId, name: item.name, sport: item.sport?.name ?? null,
        priceMode: item.priceMode.toLowerCase(), unitPricePKR: item.unitPricePaisa / 100,
        quantityAvailable: item.quantityAvailable, active: item.active,
      }));
    } catch (error) { next(error); }
  });

  router.delete('/venues/:venueId/equipment/:equipmentId', authenticate, vendorOnly, async (request, response, next) => {
    try {
      const venueId = routeId(request, 'venueId');
      const equipmentId = routeId(request, 'equipmentId');
      await ownedVenue(venueId, request.auth!.userId);
      const result = await prisma.equipmentItem.updateMany({ where: { id: equipmentId, venueId, active: true }, data: { active: false } });
      if (!result.count) throw new HttpError(404, 'EQUIPMENT_NOT_FOUND', 'The equipment item was not found.');
      response.status(200).json(apiSuccess({ deleted: true }));
    } catch (error) { next(error); }
  });

  router.post('/venues/:venueId/media/signed-upload', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = mediaUploadSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const venueId = routeId(request, 'venueId');
      const venue = await ownedVenue(venueId, request.auth!.userId);
      validateMedia(parsed.data);
      const signed = await storage.createSignedUpload({
        ...parsed.data, fileName: safeFileName(parsed.data.fileName), vendorProfileId: venue.vendorProfileId, venueId,
      });
      response.status(201).json(apiSuccess(signed));
    } catch (error) { next(error); }
  });

  router.post('/venues/:venueId/media/confirm', authenticate, vendorOnly, async (request, response, next) => {
    const parsed = mediaConfirmSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const venueId = routeId(request, 'venueId');
      const venue = await ownedVenue(venueId, request.auth!.userId);
      const input = parsed.data;
      const expectedPrefix = `${venue.vendorProfileId}/${venueId}/`;
      const extension = validateMedia(input);
      const objectName = input.storagePath.startsWith(expectedPrefix) ? input.storagePath.slice(expectedPrefix.length) : '';
      const objectId = objectName.endsWith(extension) ? objectName.slice(0, -extension.length) : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(objectId)) {
        throw new HttpError(400, 'INVALID_STORAGE_PATH', 'The media path is not assigned to this vendor and venue.');
      }
      const actual = await storage.getObjectInfo(input.storagePath);
      if (!actual.exists) throw new HttpError(409, 'MEDIA_NOT_UPLOADED', 'Upload the file to the signed URL before confirming it.');
      if (actual.sizeBytes !== undefined && actual.sizeBytes !== input.sizeBytes) {
        throw new HttpError(400, 'MEDIA_SIZE_MISMATCH', 'The uploaded file size does not match the declared size.');
      }
      if (actual.mimeType && actual.mimeType.toLowerCase() !== input.mimeType) {
        throw new HttpError(400, 'MEDIA_TYPE_MISMATCH', 'The uploaded file type does not match the declared type.');
      }
      const media = await prisma.venueMedia.create({ data: {
        venueId, kind: input.kind, storagePath: input.storagePath,
        fileName: safeFileName(input.fileName), mimeType: input.mimeType,
        sizeBytes: input.sizeBytes, position: input.position,
      } });
      response.status(201).json(apiSuccess({
        id: media.id, kind: media.kind, storagePath: media.storagePath,
        url: storage.publicUrl(media.storagePath), fileName: media.fileName,
        mimeType: media.mimeType, sizeBytes: media.sizeBytes, position: media.position,
      }));
    } catch (error) { next(error); }
  });

  router.delete('/venues/:venueId/media/:mediaId', authenticate, vendorOnly, async (request, response, next) => {
    try {
      const venueId = routeId(request, 'venueId');
      const mediaId = routeId(request, 'mediaId');
      await ownedVenue(venueId, request.auth!.userId);
      const media = await prisma.venueMedia.findFirst({ where: { id: mediaId, venueId } });
      if (!media) throw new HttpError(404, 'MEDIA_NOT_FOUND', 'The venue media item was not found.');
      await storage.deleteObject(media.storagePath);
      await prisma.venueMedia.delete({ where: { id: mediaId } });
      response.status(200).json(apiSuccess({ deleted: true }));
    } catch (error) { next(error); }
  });

  router.get('/venues/:venueId/reviews', async (request, response, next) => {
    try {
      const venueId = routeId(request, 'venueId');
      const venue = await prisma.venue.findFirst({ where: { id: venueId, published: true, deletedAt: null }, select: { id: true } });
      if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
      const [reviews, aggregate] = await Promise.all([
        prisma.review.findMany({ where: { venueId }, include: { player: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
        prisma.review.aggregate({ where: { venueId }, _avg: { stars: true }, _count: { _all: true } }),
      ]);
      response.status(200).json(apiSuccess({
        items: reviews.map(item => ({ id: item.id, bookingId: item.bookingId, venueId, playerName: item.player.name, stars: item.stars, comment: item.comment, createdAt: item.createdAt })),
        ratingAverage: aggregate._avg.stars ?? 0, ratingCount: aggregate._count._all,
      }));
    } catch (error) { next(error); }
  });

  router.post('/venues/:venueId/reviews', authenticate, requireRole('PLAYER'), async (request, response, next) => {
    const parsed = reviewCreateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const venueId = routeId(request, 'venueId');
      const venue = await prisma.venue.findFirst({ where: { id: venueId, published: true, deletedAt: null }, select: { id: true } });
      if (!venue) throw new HttpError(404, 'VENUE_NOT_FOUND', 'The venue was not found.');
      const booking = await prisma.booking.findFirst({ where: {
        id: parsed.data.bookingId, venueId, customerUserId: request.auth!.userId, status: 'COMPLETED',
      }, select: { id: true } });
      if (!booking) throw new HttpError(403, 'REVIEW_NOT_ELIGIBLE', 'A review requires a completed booking for this venue made by your account.');
      let review;
      try {
        review = await prisma.review.create({ data: {
          venueId, bookingId: booking.id, playerUserId: request.auth!.userId,
          stars: parsed.data.stars, comment: parsed.data.comment,
        }, include: { player: { select: { name: true } } } });
      } catch (error) {
        if (isUniqueViolation(error)) throw new HttpError(409, 'REVIEW_ALREADY_EXISTS', 'A review has already been submitted for this booking.');
        throw error;
      }
      response.status(201).json(apiSuccess({
        id: review.id, bookingId: review.bookingId, venueId, playerName: review.player.name,
        stars: review.stars, comment: review.comment, createdAt: review.createdAt,
      }));
    } catch (error) { next(error); }
  });

  router.patch('/venues/:venueId/reviews/:reviewId', authenticate, requireRole('PLAYER'), async (request, response, next) => {
    const parsed = reviewUpdateSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const venueId = routeId(request, 'venueId');
      const reviewId = routeId(request, 'reviewId');
      const existing = await prisma.review.findFirst({ where: { id: reviewId, venueId, playerUserId: request.auth!.userId } });
      if (!existing) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'The review was not found.');
      const updated = await prisma.review.update({ where: { id: reviewId }, data: {
        ...(parsed.data.stars !== undefined ? { stars: parsed.data.stars } : {}),
        ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
      }, include: { player: { select: { name: true } } } });
      response.status(200).json(apiSuccess({
        id: updated.id, bookingId: updated.bookingId, venueId, playerName: updated.player.name,
        stars: updated.stars, comment: updated.comment, createdAt: updated.createdAt, updatedAt: updated.updatedAt,
      }));
    } catch (error) { next(error); }
  });

  return router;
}
