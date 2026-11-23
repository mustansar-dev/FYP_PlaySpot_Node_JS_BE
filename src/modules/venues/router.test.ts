import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createAccessToken } from '../auth/tokens.js';
import { createVenueRouter } from './router.js';
import type { VenueStorage } from './storage.js';

const secret = 'venue-test-access-secret-that-is-long-enough';
const venueId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const playerId = '44444444-4444-4444-8444-444444444444';

function venueRecord() {
  return {
    id: venueId, vendorProfileId: profileId, name: 'Futsal Arena', description: null,
    address: 'Main Road', city: 'Lahore', locationNote: null, latitude: 31.5, longitude: 74.35,
    location: null, timeZone: 'Asia/Karachi', parkingAvailable: false, parkingSpaces: 0,
    published: true, createdAt: new Date('2026-11-11T10:00:00Z'), updatedAt: new Date('2026-11-11T10:00:00Z'), deletedAt: null,
    sports: [{ sport: { id: 'sport-1', code: 'futsal', name: 'Futsal' } }],
    amenities: [{ amenity: { id: 'amenity-1', name: 'Washrooms' } }, { amenity: { id: 'amenity-2', name: 'Cafe' } }],
    media: [], courts: [], equipment: [], _count: { reviews: 0 },
  };
}

function setup(options: {
  role?: 'PLAYER' | 'VENDOR'; owner?: boolean; eligibleBooking?: boolean; storage?: VenueStorage;
  verificationStatus?: 'PENDING' | 'APPROVED'; allowPendingVendorPublish?: boolean;
} = {}) {
  const role = options.role ?? 'VENDOR';
  const userId = role === 'PLAYER' ? playerId : ownerId;
  const rawQueryParameters: unknown[][] = [];
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ id: userId, role, status: 'ACTIVE' })) },
    vendorProfile: { findUnique: vi.fn(async () => ({ id: profileId, verificationStatus: options.verificationStatus ?? 'APPROVED' })) },
    venue: {
      findFirst: vi.fn(async () => options.owner === false ? null : { id: venueId, vendorProfileId: profileId, published: true }),
      findMany: vi.fn(async () => []), count: vi.fn(async () => 0),
      create: vi.fn(), update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...venueRecord(), ...data })), updateMany: vi.fn(async () => ({ count: 1 })),
    },
    venueSport: { deleteMany: vi.fn(), createMany: vi.fn() },
    venueAmenity: { deleteMany: vi.fn(), createMany: vi.fn() },
    sport: { findMany: vi.fn(async () => []) },
    amenity: { findMany: vi.fn(async () => []), upsert: vi.fn() },
    court: { findMany: vi.fn(async () => []), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() , groupBy: vi.fn(async () => []) },
    equipmentItem: { findMany: vi.fn(async () => []), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    venueMedia: { create: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
    review: {
      groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []), aggregate: vi.fn(async () => ({ _avg: { stars: null }, _count: { _all: 0 } })),
      create: vi.fn(), findFirst: vi.fn(), update: vi.fn(),
    },
    booking: { findFirst: vi.fn(async () => options.eligibleBooking ? { id: '66666666-6666-4666-8666-666666666666' } : null) },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      rawQueryParameters.push(values);
      const sql = strings.join('');
      if (sql.includes('FROM pg_extension')) return Promise.resolve([{ schema: 'public' }]);
      return Promise.resolve(sql.includes('COUNT(*)') ? [{ total: 1n }] : [{ id: venueId, distance_m: 500 }]);
    }),
    $executeRaw: vi.fn(async () => 1),
  } as unknown as PrismaClient & Record<string, unknown>;

  const storage: VenueStorage = options.storage ?? {
    createSignedUpload: vi.fn(async input => ({ storagePath: `${input.vendorProfileId}/${input.venueId}/object.jpg`, signedUrl: 'https://storage.test/upload', token: 'upload-token', expiresInSeconds: 7200 })),
    getObjectInfo: vi.fn(async () => ({ exists: true, sizeBytes: 1024, mimeType: 'image/jpeg' })),
    publicUrl: vi.fn(path => `https://storage.test/public/${path}`),
    deleteObject: vi.fn(async () => undefined),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createVenueRouter({
    prisma, accessSecret: secret, storage,
    ...(options.allowPendingVendorPublish !== undefined ? { allowPendingVendorPublish: options.allowPendingVendorPublish } : {}),
  }));
  app.use(errorHandler);
  const token = createAccessToken(userId, role, secret);
  return { app, prisma, storage, token, rawQueryParameters };
}

describe('venue catalog routes', () => {
  it('allows a pending vendor to publish their venue only when the development policy enables it', async () => {
    const { app, token, prisma } = setup({ verificationStatus: 'PENDING', allowPendingVendorPublish: true });
    const response = await request(app).patch(`/api/v1/venues/${venueId}`).set('Authorization', `Bearer ${token}`).send({ published: true });

    expect(response.status).toBe(200);
    expect(response.body.data.published).toBe(true);
    expect(mockMethod(prisma, 'venue', 'update')).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: venueId }, data: expect.objectContaining({ published: true }),
    }));
  });

  it('keeps venue publishing approval-gated when development publishing is disabled', async () => {
    const { app, token, prisma } = setup({ verificationStatus: 'PENDING', allowPendingVendorPublish: false });
    const response = await request(app).patch(`/api/v1/venues/${venueId}`).set('Authorization', `Bearer ${token}`).send({ published: true });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('VENDOR_NOT_APPROVED');
    expect(mockMethod(prisma, 'venue', 'update')).not.toHaveBeenCalled();
  });

  it('returns active sports with stable IDs for mobile room and tournament forms', async () => {
    const { app, prisma } = setup();
    mockMethod(prisma, 'sport', 'findMany').mockResolvedValueOnce([{ id: venueId, name: 'Futsal', code: 'futsal' }] as never);
    const response = await request(app).get('/api/v1/sports');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: venueId, name: 'Futsal', code: 'futsal' }]);
    expect(mockMethod(prisma, 'sport', 'findMany')).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true } }));
  });

  it('rejects out-of-range coordinates before creating a venue', async () => {
    const { app, token, prisma } = setup();
    const response = await request(app).post('/api/v1/venues').set('Authorization', `Bearer ${token}`).send({
      name: 'Arena', address: 'Main Road', city: 'Lahore', sports: ['Futsal'], latitude: 91, longitude: 74,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockMethod(prisma, 'venue', 'create')).not.toHaveBeenCalled();
  });

  it('does not allow one vendor to update another vendor venue', async () => {
    const { app, token, prisma } = setup({ owner: false });
    const response = await request(app).patch(`/api/v1/venues/${venueId}`).set('Authorization', `Bearer ${token}`).send({ name: 'Hijacked venue' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('VENUE_NOT_FOUND');
    expect(mockMethod(prisma, 'venue', 'update')).not.toHaveBeenCalled();
  });

  it('requires all requested amenities and applies bounded pagination', async () => {
    const { app, prisma } = setup();
    const response = await request(app).get('/api/v1/venues?amenities=Washrooms,Cafe&indoorOutdoor=Indoor&page=2&limit=3&sort=name');
    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({ page: 2, limit: 3, total: 0 });
    const findMany = mockMethod(prisma, 'venue', 'findMany');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 3, take: 3 }));
    expect(findMany.mock.calls[0]?.[0].where.AND).toHaveLength(2);
    expect(findMany.mock.calls[0]?.[0].where.courts.some.indoorOutdoor).toBe('INDOOR');
  });

  it('uses longitude then latitude in a parameterized PostGIS nearby query and returns the DB distance', async () => {
    const { app, prisma, rawQueryParameters } = setup();
    const findMany = mockMethod(prisma, 'venue', 'findMany');
    findMany.mockResolvedValueOnce([venueRecord()] as never);
    const response = await request(app).get('/api/v1/venues/nearby?lat=31.5&lng=74.35&radiusKm=1');
    expect(response.status).toBe(200);
    expect(response.body.data[0].distanceKm).toBe(0.5);
    const spatialQueries = rawQueryParameters.filter(values => values.length > 0);
    expect(spatialQueries).toHaveLength(2);
    const flattened = spatialQueries.map(flattenSqlParameters);
    expect(flattened[0]?.slice(0, 2)).toEqual([74.35, 31.5]);
    expect(flattened.every(values => values.includes(74.35) && values.includes(31.5) && values.includes(1000))).toBe(true);
  });

  it('returns an empty review list and zero rating for a venue without reviews', async () => {
    const { app } = setup({ role: 'PLAYER' });
    const response = await request(app).get(`/api/v1/venues/${venueId}/reviews`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ items: [], ratingAverage: 0, ratingCount: 0 });
  });

  it('requires vendor authentication before requesting a media upload URL', async () => {
    const { app, storage } = setup();
    const response = await request(app).post(`/api/v1/venues/${venueId}/media/signed-upload`).send({
      kind: 'PHOTO', fileName: 'court.jpg', mimeType: 'image/jpeg', sizeBytes: 1024,
    });
    expect(response.status).toBe(401);
    expect(storage.createSignedUpload).not.toHaveBeenCalled();
  });

  it('does not let a vendor request an upload URL for another vendor venue', async () => {
    const { app, token, storage } = setup({ owner: false });
    const response = await request(app).post(`/api/v1/venues/${venueId}/media/signed-upload`).set('Authorization', `Bearer ${token}`).send({
      kind: 'PHOTO', fileName: 'court.jpg', mimeType: 'image/jpeg', sizeBytes: 1024,
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('VENUE_NOT_FOUND');
    expect(storage.createSignedUpload).not.toHaveBeenCalled();
  });

  it('rejects media confirmation unless the uploaded object exists at the vendor venue path', async () => {
    const storage = {
      createSignedUpload: vi.fn(), getObjectInfo: vi.fn(async () => ({ exists: false })),
      publicUrl: vi.fn(), deleteObject: vi.fn(),
    } satisfies VenueStorage;
    const { app, token, prisma } = setup({ storage });
    const response = await request(app).post(`/api/v1/venues/${venueId}/media/confirm`).set('Authorization', `Bearer ${token}`).send({
      kind: 'PHOTO', fileName: 'court.jpg', mimeType: 'image/jpeg', sizeBytes: 1024,
      storagePath: `${profileId}/${venueId}/55555555-5555-4555-8555-555555555555.jpg`,
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('MEDIA_NOT_UPLOADED');
    expect(storage.getObjectInfo).toHaveBeenCalledOnce();
    expect(mockMethod(prisma, 'venueMedia', 'create')).not.toHaveBeenCalled();
  });

  it('requires the authenticated player to have a completed booking for the venue before reviewing', async () => {
    const { app, token, prisma } = setup({ role: 'PLAYER' });
    const response = await request(app).post(`/api/v1/venues/${venueId}/reviews`).set('Authorization', `Bearer ${token}`).send({
      bookingId: '66666666-6666-4666-8666-666666666666', stars: 5, comment: 'Excellent playing surface.',
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('REVIEW_NOT_ELIGIBLE');
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it('returns a review-specific conflict when the booking/user unique constraint rejects a duplicate', async () => {
    const { app, token, prisma } = setup({ role: 'PLAYER', eligibleBooking: true });
    mockMethod(prisma, 'review', 'create').mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    const response = await request(app).post(`/api/v1/venues/${venueId}/reviews`).set('Authorization', `Bearer ${token}`).send({
      bookingId: '66666666-6666-4666-8666-666666666666', stars: 5, comment: 'Excellent playing surface.',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('REVIEW_ALREADY_EXISTS');
  });
});

function mockMethod(client: PrismaClient, model: string, method: string): ReturnType<typeof vi.fn> {
  const root = client as unknown as Record<string, unknown>;
  if (model === '$queryRaw') return root.$queryRaw as ReturnType<typeof vi.fn>;
  return (root[model] as Record<string, unknown>)[method] as ReturnType<typeof vi.fn>;
}

function flattenSqlParameters(values: unknown[]): unknown[] {
  return values.flatMap(value => typeof value === 'object' && value !== null && 'values' in value && Array.isArray(value.values)
    ? flattenSqlParameters(value.values)
    : [value]);
}
