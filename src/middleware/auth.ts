import type { RequestHandler } from 'express';
import type { PrismaClient, UserRole } from '../generated/prisma/client.js';
import { apiError } from '../common/apiResponse.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

declare module 'express-serve-static-core' {
  interface Request { auth?: { userId: string; role: UserRole }; }
}

export function requireAuth(prisma: PrismaClient, accessSecret: string): RequestHandler {
  return async (request, response, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(request.header('authorization') ?? '');
    const claims = match?.[1] ? verifyAccessToken(match[1], accessSecret) : undefined;
    if (!claims) {
      response.status(401).json(apiError('UNAUTHORIZED', 'A valid access token is required.'));
      return;
    }
    try {
      const user = await prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true, role: true, status: true } });
      if (!user || user.status !== 'ACTIVE') {
        response.status(401).json(apiError('UNAUTHORIZED', 'The account is unavailable.'));
        return;
      }
      request.auth = { userId: user.id, role: user.role };
      next();
    } catch (error) { next(error); }
  };
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (request, response, next) => {
    if (!request.auth || !roles.includes(request.auth.role)) {
      response.status(403).json(apiError('FORBIDDEN', 'This action is not available for this account.'));
      return;
    }
    next();
  };
}
