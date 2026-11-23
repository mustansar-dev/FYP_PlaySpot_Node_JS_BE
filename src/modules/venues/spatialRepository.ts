import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { HttpError } from '../../common/httpError.js';

export interface NearbyVenueRow { id: string; distance_m: number | null; }

type PostgisQueryable = Pick<PrismaClient, '$queryRaw'>;

async function postgisSql(prisma: PostgisQueryable) {
  const rows = await prisma.$queryRaw<Array<{ schema: string }>>`
    SELECT n.nspname AS schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'postgis'
    LIMIT 1
  `;
  const schema = rows[0]?.schema;
  if (!schema || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new HttpError(503, 'SPATIAL_SEARCH_UNAVAILABLE', 'Venue distance search is not available because PostGIS is not installed.');
  }
  const namespace = `"${schema}"`;
  return {
    geography: Prisma.raw(`${namespace}."geography"`),
    dWithin: Prisma.raw(`${namespace}."st_dwithin"`),
    distance: Prisma.raw(`${namespace}."st_distance"`),
    makePoint: Prisma.raw(`${namespace}."st_makepoint"`),
    setSrid: Prisma.raw(`${namespace}."st_setsrid"`),
  };
}

/** Spatial filtering stays in PostgreSQL and uses the location GiST index. */
export async function findNearbyVenueIds(
  prisma: PrismaClient,
  input: {
    latitude: number; longitude: number; radiusMeters: number; offset: number; limit: number;
    q?: string; city?: string; sport?: string; amenities?: string[];
    indoorOutdoor?: 'INDOOR' | 'OUTDOOR'; minPricePaisa?: number; maxPricePaisa?: number; minRating?: number;
  },
): Promise<{ rows: NearbyVenueRow[]; total: number }> {
  const postgis = await postgisSql(prisma);
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
  const origin = Prisma.sql`${postgis.setSrid}(${postgis.makePoint}(${input.longitude}, ${input.latitude}), 4326)::${postgis.geography}`;
  const withinRadius = Prisma.sql`(v.location IS NULL OR ${postgis.dWithin}(v.location, ${origin}, ${input.radiusMeters}))`;
  const point = prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COUNT(*)::bigint AS total
    FROM public.venues v
    WHERE v.deleted_at IS NULL
      AND v.published = TRUE
      AND ${withinRadius}
      ${filterSql}
  `;
  const result = prisma.$queryRaw<NearbyVenueRow[]>`
    SELECT v.id::text AS id,
      CASE WHEN v.location IS NULL THEN NULL ELSE ${postgis.distance}(v.location, ${origin}) END AS distance_m
    FROM public.venues v
    WHERE v.deleted_at IS NULL
      AND v.published = TRUE
      AND ${withinRadius}
      ${filterSql}
    ORDER BY distance_m ASC NULLS LAST, v.id ASC
    OFFSET ${input.offset}
    LIMIT ${input.limit}
  `;
  const [countRows, rows] = await Promise.all([point, result]);
  return { rows, total: Number(countRows[0]?.total ?? 0n) };
}

export async function setVenuePoint(
  prisma: Pick<PrismaClient, '$executeRaw' | '$queryRaw'>,
  venueId: string,
  latitude: number | null,
  longitude: number | null,
): Promise<void> {
  if (latitude === null || longitude === null) {
    await prisma.$executeRaw`UPDATE public.venues SET location = NULL WHERE id = ${venueId}::uuid`;
    return;
  }
  const postgis = await postgisSql(prisma);
  await prisma.$executeRaw`
    UPDATE public.venues
    SET location = ${postgis.setSrid}(${postgis.makePoint}(${longitude}, ${latitude}), 4326)::${postgis.geography}
    WHERE id = ${venueId}::uuid
  `;
}
