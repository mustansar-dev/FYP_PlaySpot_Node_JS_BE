import { describe, expect, it } from 'vitest';
import { createAccessToken, createRefreshToken, hashRefreshToken, verifyAccessToken } from './tokens.js';

describe('auth token helpers', () => {
  const secret = 'a-test-secret-that-is-long-enough-for-hmac';

  it('signs a short-lived access token and rejects tampering or expiry', () => {
    const now = Date.UTC(2026, 10, 11);
    const token = createAccessToken('user-1', 'PLAYER', secret, now);
    expect(verifyAccessToken(token, secret, now)).toMatchObject({ sub: 'user-1', role: 'PLAYER' });
    expect(verifyAccessToken(`${token.slice(0, -1)}x`, secret, now)).toBeUndefined();
    expect(verifyAccessToken(token, secret, now + 16 * 60 * 1000)).toBeUndefined();
  });

  it('creates unguessable refresh tokens and secret-keyed digests', () => {
    const first = createRefreshToken();
    const second = createRefreshToken();
    expect(first).not.toBe(second);
    expect(hashRefreshToken(first, secret)).not.toBe(first);
    expect(hashRefreshToken(first, secret)).not.toBe(hashRefreshToken(first, 'a-different-secret'));
  });
});
