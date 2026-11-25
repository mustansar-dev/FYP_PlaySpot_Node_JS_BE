import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { apiError, apiSuccess } from '../../common/apiResponse.js';
import { HttpError } from '../../common/httpError.js';

const tileSchema = z.object({
  z: z.coerce.number().int().min(0).max(20),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
});
const geocodeSchema = z.object({
  q: z.string().trim().min(2).max(160),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
});
const reverseSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

interface GeoapifyAddress {
  name?: string;
  formatted?: string;
  address_line1?: string;
  address_line2?: string;
  lat?: number;
  lon?: number;
  city?: string;
  state?: string;
}

interface GeoapifyJson {
  results?: GeoapifyAddress[];
}

interface MapsRouterOptions {
  geoapifyApiKey?: string;
}

function sendInvalid(response: Response, issues: { path: PropertyKey[]; message: string }[]) {
  response.status(400).json(apiError('VALIDATION_ERROR', 'The request is invalid.', issues.map(issue => ({
    field: issue.path.join('.'), message: issue.message,
  }))));
}

function mapPlace(address: GeoapifyAddress) {
  const label = address.formatted || [address.name, address.address_line1, address.address_line2]
    .filter((part, index, parts) => part && parts.indexOf(part) === index).join(', ');
  return {
    label: label || 'Selected location',
    latitude: address.lat,
    longitude: address.lon,
    city: address.city ?? null,
    state: address.state ?? null,
  };
}

async function fetchGeoapifyJson(url: URL): Promise<GeoapifyJson> {
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new HttpError(timedOut ? 504 : 502, timedOut ? 'MAP_PROVIDER_TIMEOUT' : 'MAP_PROVIDER_UNAVAILABLE',
      timedOut ? 'The map provider took too long to respond.' : 'The map provider is unavailable.');
  }
  if (!upstream.ok) {
    throw new HttpError(502, 'MAP_PROVIDER_UNAVAILABLE', 'The map provider could not complete the location request.');
  }
  return await upstream.json() as GeoapifyJson;
}

export function createMapsRouter({ geoapifyApiKey }: MapsRouterOptions): Router {
  const router = Router();
  const tileLimiter = rateLimit({ windowMs: 60_000, limit: 1_800, standardHeaders: 'draft-8', legacyHeaders: false });
  const geocodeLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  router.get('/map/status', (_request, response) => {
    response.status(200).json(apiSuccess({ configured: Boolean(geoapifyApiKey?.trim()) }));
  });

  router.get('/map/tiles/:z/:x/:y', tileLimiter, async (request: Request, response: Response) => {
    const parsed = tileSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).type('text/plain').send('Invalid map tile coordinates.');
      return;
    }
    const { z, x, y } = parsed.data;
    const maxIndex = 2 ** z - 1;
    if (x > maxIndex || y > maxIndex) {
      response.status(400).type('text/plain').send('Invalid map tile coordinates.');
      return;
    }
    if (!geoapifyApiKey?.trim()) {
      response.status(503).type('text/plain').send('Map tiles are not configured on this PlaySpot server.');
      return;
    }

    const url = new URL(`https://maps.geoapify.com/v1/tile/osm-carto/${z}/${x}/${y}.png`);
    url.searchParams.set('apiKey', geoapifyApiKey.trim());
    try {
      const upstream = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: request.header('if-none-match') ? { 'If-None-Match': request.header('if-none-match')! } : {},
      });
      if (!upstream.ok || !upstream.headers.get('content-type')?.includes('image/png')) {
        response.status(502).type('text/plain').send('Map tiles are temporarily unavailable.');
        return;
      }
      response.status(200).type('image/png');
      const cacheControl = upstream.headers.get('cache-control');
      const etag = upstream.headers.get('etag');
      if (cacheControl) response.setHeader('Cache-Control', cacheControl);
      if (etag) response.setHeader('ETag', etag);
      response.send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.status(502).type('text/plain').send('Map tiles are temporarily unavailable.');
    }
  });

  router.get('/map/geocode', geocodeLimiter, async (request, response, next) => {
    const parsed = geocodeSchema.safeParse(request.query);
    if (!parsed.success) { sendInvalid(response, parsed.error.issues); return; }
    if (!geoapifyApiKey?.trim()) {
      next(new HttpError(503, 'MAP_SERVICE_NOT_CONFIGURED', 'Add GEOAPIFY_API_KEY to the backend .env file and restart the backend.'));
      return;
    }
    const { q, lat, lon } = parsed.data;
    const url = new URL('https://api.geoapify.com/v1/geocode/search');
    url.searchParams.set('text', q);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '5');
    url.searchParams.set('filter', 'countrycode:pk');
    if (lat !== undefined && lon !== undefined) url.searchParams.set('bias', `proximity:${lon},${lat}`);
    url.searchParams.set('apiKey', geoapifyApiKey.trim());
    try {
      const data = await fetchGeoapifyJson(url);
      response.status(200).json(apiSuccess((data.results ?? []).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon)).map(mapPlace)));
    } catch (error) { next(error); }
  });

  router.get('/map/reverse', geocodeLimiter, async (request, response, next) => {
    const parsed = reverseSchema.safeParse(request.query);
    if (!parsed.success) { sendInvalid(response, parsed.error.issues); return; }
    if (!geoapifyApiKey?.trim()) {
      next(new HttpError(503, 'MAP_SERVICE_NOT_CONFIGURED', 'Add GEOAPIFY_API_KEY to the backend .env file and restart the backend.'));
      return;
    }
    const url = new URL('https://api.geoapify.com/v1/geocode/reverse');
    url.searchParams.set('lat', String(parsed.data.lat));
    url.searchParams.set('lon', String(parsed.data.lon));
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('apiKey', geoapifyApiKey.trim());
    try {
      const data = await fetchGeoapifyJson(url);
      const place = data.results?.[0];
      response.status(200).json(apiSuccess(place ? mapPlace(place) : null));
    } catch (error) { next(error); }
  });

  return router;
}
