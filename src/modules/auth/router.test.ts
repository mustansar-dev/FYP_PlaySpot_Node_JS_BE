import express from 'express';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createAccessToken, createRefreshToken, hashRefreshToken } from './tokens.js';
import { createAuthRouter } from './router.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

const accessSecret = 'test-access-secret-that-is-long-enough';
const refreshSecret = 'test-refresh-secret-that-is-long-enough';

function setup() {
  const user = {
    id: 'user-1', role: 'PLAYER', name: 'A Player', email: 'player@example.com', phone: '03001234567',
    status: 'ACTIVE', preferredSports: [], vendorProfile: null,
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    user: {
      create: vi.fn(async ({ data }: { data: { role: string } }) => ({ ...user, role: data.role })),
      findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => user), update: vi.fn(async () => user),
    },
    sport: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    refreshToken: {
      create: vi.fn(async () => ({ id: 'token-1' })), findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })),
    },
    userSport: { deleteMany: vi.fn(), createMany: vi.fn() },
    vendorProfile: { findUnique: vi.fn(), update: vi.fn() },
  } as unknown as PrismaClient;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createAuthRouter({ prisma, accessSecret, refreshSecret }));
  app.use(errorHandler);
  return { app, prisma, user };
}

describe('authentication routes', () => {
  it('validates player registration before writing and returns a safe user plus session', async () => {
    const { app, prisma } = setup();
    const invalid = await request(app).post('/api/v1/auth/register/player').send({ email: 'bad' });
    expect(invalid.status).toBe(400);
    expect(prisma.user.create).not.toHaveBeenCalled();

    const response = await request(app).post('/api/v1/auth/register/player').send({
      name: 'A Player', email: ' PLAYER@example.com ', phone: '03001234567', password: 'secure-pass-123',
      confirmPassword: 'secure-pass-123', preferredSports: [], role: 'VENDOR',
    });
    expect(response.status).toBe(201);
    expect(response.body.data.user.role).toBe('PLAYER');
    expect(response.body.data.user).not.toHaveProperty('passwordHash');
    expect(response.body.data.accessToken).toBeTruthy();
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'PLAYER', email: 'player@example.com' }) }));
  });

  it('accepts every player-interest label used by the frontend when the seeded catalog exists', async () => {
    const { app, prisma } = setup();
    vi.mocked(prisma.sport.findMany).mockResolvedValueOnce([
      { id: 'sport-futsal' }, { id: 'sport-cricket' }, { id: 'sport-padel' }, { id: 'sport-badminton' },
    ] as never);
    const response = await request(app).post('/api/v1/auth/register/player').send({
      name: 'A Player', email: 'sports@example.com', password: 'secure-pass-123', confirmPassword: 'secure-pass-123',
      preferredSports: ['Futsal', 'Cricket', 'Padel', 'Badminton'],
    });

    expect(response.status).toBe(201);
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      preferredSports: { create: [{ sportId: 'sport-futsal' }, { sportId: 'sport-cricket' }, { sportId: 'sport-padel' }, { sportId: 'sport-badminton' }] },
    }) }));
  });

  it('reports an actionable setup error when the sport reference table is empty', async () => {
    const { app, prisma } = setup();
    const response = await request(app).post('/api/v1/auth/register/player').send({
      name: 'A Player', email: 'unseeded@example.com', password: 'secure-pass-123', confirmPassword: 'secure-pass-123',
      preferredSports: ['Futsal'],
    });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SPORT_CATALOG_NOT_SEEDED');
    expect(response.body.error.message).toContain('npm run setup');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects a player from vendor profile routes using the persisted role', async () => {
    const { app, prisma } = setup();
    const token = createAccessToken('user-1', 'VENDOR', accessSecret);
    const response = await request(app).get('/api/v1/vendors/me').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(prisma.vendorProfile.findUnique).not.toHaveBeenCalled();
  });

  it('registers vendors with a pending profile and prevents duplicate accounts', async () => {
    const { app, prisma } = setup();
    const payload = {
      name: 'A Vendor', email: 'vendor@example.com', phone: '+92 300-1234567', password: 'secure-pass-123',
      confirmPassword: 'secure-pass-123', businessName: 'PlaySpot Venue',
    };
    const response = await request(app).post('/api/v1/auth/register/vendor').send(payload);
    expect(response.status).toBe(201);
    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      role: 'VENDOR', phone: '+923001234567', vendorProfile: { create: { businessName: 'PlaySpot Venue', contactPhone: '+923001234567' } },
    }) }));

    vi.mocked(prisma.user.create).mockRejectedValueOnce(Object.assign(new Error('unique violation'), { code: 'P2002' }));
    const duplicate = await request(app).post('/api/v1/auth/register/vendor').send(payload);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_ACCOUNT');
    expect(JSON.stringify(duplicate.body)).not.toContain('unique violation');
  });

  it('accepts the frontend email login form and returns one generic wrong-password error', async () => {
    const { app, prisma, user } = setup();
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
      ...user, passwordHash: await bcrypt.hash('right-password-123', 4),
    } as never);
    const response = await request(app).post('/api/v1/auth/login').send({ email: 'PLAYER@example.com', password: 'wrong-password' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'player@example.com' } }));
  });

  it('rotates a refresh token once and rejects replay of the revoked token', async () => {
    const { app, prisma, user } = setup();
    const oldToken = createRefreshToken();
    const existing = {
      id: 'refresh-1', userId: user.id, tokenHash: hashRefreshToken(oldToken, refreshSecret),
      expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
    };
    vi.mocked(prisma.refreshToken.findUnique).mockResolvedValueOnce(existing as never).mockResolvedValueOnce({
      ...existing, revokedAt: new Date(),
    } as never);
    const rotation = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: oldToken });
    expect(rotation.status).toBe(200);
    expect(rotation.body.data.refreshToken).not.toBe(oldToken);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'refresh-1', revokedAt: null }),
    }));

    const replay = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: oldToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    expect(prisma.refreshToken.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { userId: user.id, revokedAt: null },
    }));
  });

  it('logout revokes active refresh sessions for the authenticated account', async () => {
    const { app, prisma, user } = setup();
    const token = createAccessToken(user.id, 'PLAYER', accessSecret);
    const response = await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.data.loggedOut).toBe(true);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, revokedAt: null }, data: { revokedAt: expect.any(Date) },
    });
  });

  it('rejects missing and invalid bearer tokens on protected routes', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer invalid')).status).toBe(401);
  });
});
