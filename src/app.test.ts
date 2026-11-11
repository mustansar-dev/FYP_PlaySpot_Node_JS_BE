import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

const appOptions = {
  apiPrefix: '/api/v1',
  allowedOrigins: ['http://localhost:8081'],
  checkDatabase: vi.fn<() => Promise<void>>(),
};

describe('health endpoints', () => {
  it('serves liveness without requiring a database query', async () => {
    const app = createApp(appOptions);
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { status: 'ok' } });
    expect(appOptions.checkDatabase).not.toHaveBeenCalled();
  });

  it('reports database readiness when the query succeeds', async () => {
    appOptions.checkDatabase.mockResolvedValueOnce();
    const app = createApp(appOptions);
    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body.data.database).toBe('connected');
  });

  it('returns an actionable 503 when the database query fails', async () => {
    appOptions.checkDatabase.mockRejectedValueOnce(new Error('private connection detail'));
    const app = createApp(appOptions);
    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('private connection detail');
  });

  it('returns the common not-found envelope', async () => {
    const app = createApp(appOptions);
    const response = await request(app).get('/api/v1/missing');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects browser origins outside the configured allowlist', async () => {
    const app = createApp(appOptions);
    const response = await request(app).get('/health').set('Origin', 'https://untrusted.example');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });
});
