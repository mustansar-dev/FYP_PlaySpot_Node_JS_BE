import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

export interface NearbyVenueRow { id: string; distance_m: number; }

/** Spatial filtering stays in PostgreSQL and uses the location GiST index. */
export async function findNearbyVenueIds(
  prisma: PrismaClient,
  input: {
    latitude: number; longitude: number; radiusMeters: number; offset: number; limit: number;
    q?: string; city?: string; sport?: string; amenities?: string[];
    indoorOutdoor?: 'INDOOR' | 'OUTDOOR'; minPricePaisa?: number; maxPricePaisa?: number; minRating?: number;
  },
): Promise<{ rows: NearbyVenueRow[]; total: number }> {
  const filters: Prisma.Sql[] = [];
  if (input.q) filters.push(Prisma.sql`(v.name ILIKE ${`%${input.q}%`} OR v.address ILIKE ${`%${input.q}%`} OR v.city ILIKE ${`%${input.q}%`})`);
  if (input.city) filters.push(Prisma.sql`v.city ILIKE ${input.city}`);
  if (input.sport) filters.push(Prisma.sql`EXISTS (
    SELECT 1 FROM public.venue_sports vs JOIN public.sports s ON s.id = vs.sport_id
    WHERE vs.venue_id = v.id AND s.is_active = TRUE AND (s.code ILIKE ${input.sport} OR s.name ILIKE ${input.sport})
  )`);
  for (const amenity of input.amenities ?? []) filters.push(Prisma.sql`EXISTS (
    SELECT 1 FROM public.venue_amenities va JOIN public.amenities a ON a.id = va.amenity_id
    WHERE va.venue_id = v.id AND a.is_active = TRUE AND a.name ILIKE ${amenity}
  )`);
  if (input.indoorOutdoor !== undefined || input.minPricePaisa !== undefined || input.maxPricePaisa !== undefined) filters.push(Prisma.sql`EXISTS (
    SELECT 1 FROM public.courts c WHERE c.venue_id = v.id AND c.is_active = TRUE
      ${input.indoorOutdoor === undefined ? Prisma.empty : Prisma.sql`AND c.indoor_outdoor::text = ${input.indoorOutdoor}`}
      ${input.minPricePaisa === undefined ? Prisma.empty : Prisma.sql`AND c.hourly_price_paisa >= ${input.minPricePaisa}`}
      ${input.maxPricePaisa === undefined ? Prisma.empty : Prisma.sql`AND c.hourly_price_paisa <= ${input.maxPricePaisa}`}
  )`);
  if (input.minRating !== undefined) filters.push(Prisma.sql`COALESCE((
    SELECT AVG(r.stars)::double precision FROM public.reviews r WHERE r.venue_id = v.id
  ), 0) >= ${input.minRating}`);
  const filterSql = filters.length ? Prisma.sql`AND ${Prisma.join(filters, ' AND ')}` : Prisma.empty;
  const point = prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COUNT(*)::bigint AS total
    FROM public.venues v
    WHERE v.deleted_at IS NULL
      AND v.published = TRUE
      AND v.location IS NOT NULL
      AND public.ST_DWithin(
        v.location,
        public.ST_SetSRID(public.ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)::public.geography,
        ${input.radiusMeters}
      )
      ${filterSql}
  `;
  const result = prisma.$queryRaw<NearbyVenueRow[]>`
    SELECT v.id::text AS id,
      public.ST_Distance(
        v.location,
        public.ST_SetSRID(public.ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)::public.geography
      ) AS distance_m
    FROM public.venues v
    WHERE v.deleted_at IS NULL
      AND v.published = TRUE
      AND v.location IS NOT NULL
      AND public.ST_DWithin(
        v.location,
        public.ST_SetSRID(public.ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)::public.geography,
        ${input.radiusMeters}
      )
      ${filterSql}
    ORDER BY distance_m ASC, v.id ASC
    OFFSET ${input.offset}
    LIMIT ${input.limit}
  `;
  const [countRows, rows] = await Promise.all([point, result]);
  return { rows, total: Number(countRows[0]?.total ?? 0n) };
}

export async function setVenuePoint(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  venueId: string,
  latitude: number | null,
  longitude: number | null,
): Promise<void> {
  if (latitude === null || longitude === null) {
    await prisma.$executeRaw`UPDATE public.venues SET location = NULL WHERE id = ${venueId}::uuid`;
    return;
  }
  await prisma.$executeRaw`
    UPDATE public.venues
    SET location = public.ST_SetSRID(public.ST_MakePoint(${longitude}, ${latitude}), 4326)::public.geography
    WHERE id = ${venueId}::uuid
  `;
}
