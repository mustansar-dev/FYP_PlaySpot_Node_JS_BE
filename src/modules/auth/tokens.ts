import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { UserRole } from '../../generated/prisma/client.js';

const ACCESS_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessClaims { sub: string; role: UserRole; iat: number; exp: number; }

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function createAccessToken(userId: string, role: UserRole, secret: string, now = Date.now()): string {
  const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(now / 1000);
  const payload = encode(JSON.stringify({ sub: userId, role, iat, exp: iat + ACCESS_SECONDS }));
  const data = `${header}.${payload}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

export function verifyAccessToken(token: string, secret: string, now = Date.now()): AccessClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return undefined;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(data).digest();
  let actual: Buffer;
  try { actual = Buffer.from(parts[2], 'base64url'); } catch { return undefined; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg?: string };
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as AccessClaims;
    if (header.alg !== 'HS256' || typeof claims.sub !== 'string' || !['PLAYER', 'VENDOR'].includes(claims.role)
      || typeof claims.exp !== 'number' || claims.exp <= Math.floor(now / 1000)) return undefined;
    return claims;
  } catch { return undefined; }
}

export function createRefreshToken(): string { return randomBytes(48).toString('base64url'); }
export function hashRefreshToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}
