import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createAccessToken } from '../auth/tokens.js';
import { createAnalyticsRouter } from './router.js';

const secret = 'analytics-test-access-secret-that-is-long-enough';
const vendorId = '11111111-1111-4111-8111-111111111111';

function setup(createdAt = new Date('2026-11-20T10:00:00.000Z')) {
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ id: vendorId, role: 'VENDOR', status: 'ACTIVE' })) },
    vendorProfile: { findUnique: vi.fn(async () => ({ createdAt })) },
  } as unknown as PrismaClient;
  const app = express();
  app.use('/api/v1', createAnalyticsRouter({ prisma, accessSecret: secret }));
  app.use(errorHandler);
  return { app, token: createAccessToken(vendorId, 'VENDOR', secret), prisma };
}

describe('vendor analytics period validation', () => {
  it('rejects future dates', async () => {
    const { app, token } = setup();
    const response = await request(app).get('/api/v1/vendors/me/analytics?from=2099-01-01&to=2099-01-31')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ANALYTICS_FUTURE_RANGE');
  });

  it('rejects dates before the vendor registered', async () => {
    const { app, token } = setup();
    const response = await request(app).get('/api/v1/vendors/me/analytics?from=2026-11-01&to=2026-11-22')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ANALYTICS_BEFORE_REGISTRATION');
  });

  it('rejects a custom period longer than one calendar year', async () => {
    const { app, token } = setup();
    const response = await request(app).get('/api/v1/vendors/me/analytics?from=2025-01-01&to=2026-01-02')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
