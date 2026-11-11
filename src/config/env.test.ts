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
});
