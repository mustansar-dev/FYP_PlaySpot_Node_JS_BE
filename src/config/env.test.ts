import { describe, expect, it } from 'vitest';
import { loadConfig } from './env.js';

describe('loadConfig', () => {
  it('requires a PostgreSQL URL without exposing its value in errors', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });

  it('applies safe defaults and parses the CORS allowlist', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/playspot_test',
      APP_ORIGINS: 'http://localhost:8081, http://127.0.0.1:8081',
    });

    expect(config.PORT).toBe(4000);
    expect(config.API_PREFIX).toBe('/api/v1');
    expect(config.allowedOrigins).toEqual(['http://localhost:8081', 'http://127.0.0.1:8081']);
  });

  it('accepts empty optional provider placeholders from .env.example', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/playspot_test',
      SUPABASE_URL: '',
      SAFEPAY_RETURN_URL: '',
      SAFEPAY_CANCEL_URL: '',
    });

    expect(config.SUPABASE_URL).toBeUndefined();
    expect(config.SAFEPAY_RETURN_URL).toBeUndefined();
    expect(config.SAFEPAY_CANCEL_URL).toBeUndefined();
  });

  it('requires independent-length auth secrets outside test mode', () => {
    const base = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://test:test@localhost:5432/playspot_test' };
    expect(() => loadConfig(base)).toThrow(/JWT_ACCESS_SECRET, JWT_REFRESH_SECRET/);
    expect(() => loadConfig({ ...base, JWT_ACCESS_SECRET: 'too-short', JWT_REFRESH_SECRET: 'also-too-short' })).toThrow(/at least 32 characters/);
    expect(loadConfig({ ...base, JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32) }).JWT_ACCESS_SECRET).toHaveLength(32);
  });
});
