import { Router, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import type { Prisma, PrismaClient, UserRole } from '../../generated/prisma/client.js';
import { apiError, apiSuccess } from '../../common/apiResponse.js';
import { HttpError } from '../../common/httpError.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { hashRefreshToken, createAccessToken, createRefreshToken, REFRESH_TTL_MS } from './tokens.js';
import {
  loginSchema, playerRegistrationSchema, refreshSchema, updateUserSchema, updateVendorSchema,
  vendorRegistrationSchema,
} from './schemas.js';

interface AuthRouterOptions { prisma: PrismaClient; accessSecret: string; refreshSecret: string; }
const safeUserSelect = {
  id: true, role: true, name: true, email: true, phone: true, status: true,
  preferredSports: { select: { sport: { select: { code: true, name: true } } } },
  vendorProfile: { select: { id: true, businessName: true, contactPhone: true, verificationStatus: true } },
} as const;

function invalid(response: Response, issues: { path: PropertyKey[]; message: string }[]) {
  response.status(400).json(apiError('VALIDATION_ERROR', 'The request is invalid.', issues.map(issue => ({
    field: issue.path.join('.'), message: issue.message,
  }))));
}

export function createAuthRouter({ prisma, accessSecret, refreshSecret }: AuthRouterOptions): Router {
  const router = Router();
  const authenticate = requireAuth(prisma, accessSecret);
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

  async function issueSession(userId: string, role: UserRole) {
    const rawRefresh = createRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await prisma.refreshToken.create({ data: { userId, tokenHash: hashRefreshToken(rawRefresh, refreshSecret), expiresAt } });
    return { accessToken: createAccessToken(userId, role, accessSecret), refreshToken: rawRefresh, tokenType: 'Bearer' };
  }

  async function resolvePreferredSports(tx: Prisma.TransactionClient, values: string[]) {
    if (!values.length) return [];
    const normalized = [...new Set(values.map(value => value.trim().toLowerCase()))];
    const found = await tx.sport.findMany({
      where: { isActive: true, OR: normalized.flatMap(value => [
        { code: value }, { name: { equals: value, mode: 'insensitive' as const } },
      ]) },
      select: { id: true },
    });
    if (!found.length) {
      const hasCatalog = await tx.sport.findFirst({ where: { isActive: true }, select: { id: true } });
      if (!hasCatalog) {
        throw new HttpError(503, 'SPORT_CATALOG_NOT_SEEDED', 'Sports are not initialized in this database. Run `npm run setup` in the backend project, then retry registration.');
      }
    }
    if (found.length !== normalized.length) {
      throw new HttpError(400, 'INVALID_SPORT', 'One or more selected sports are not in the active sports catalog.');
    }
    return found;
  }

  router.post('/auth/register/player', authLimiter, async (request, response, next) => {
    const parsed = playerRegistrationSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const input = parsed.data;
      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await prisma.$transaction(async tx => {
        const sportRecords = await resolvePreferredSports(tx, input.preferredSports);
        return tx.user.create({ data: {
          role: 'PLAYER', name: input.name, email: input.email, phone: input.phone || null, passwordHash,
          preferredSports: { create: sportRecords.map(sport => ({ sportId: sport.id })) },
        }, select: safeUserSelect });
      });
      const session = await issueSession(user.id, user.role);
      response.status(201).json(apiSuccess({ user, ...session }));
    } catch (error) { next(error); }
  });

  router.post('/auth/register/vendor', authLimiter, async (request, response, next) => {
    const parsed = vendorRegistrationSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const input = parsed.data;
      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await prisma.user.create({ data: {
        role: 'VENDOR', name: input.name, email: input.email, phone: input.phone || null, passwordHash,
        vendorProfile: { create: {
          businessName: input.businessName, contactPhone: input.contactPhone || input.phone || '',
        } },
      }, select: safeUserSelect });
      const session = await issueSession(user.id, user.role);
      response.status(201).json(apiSuccess({ user, ...session }));
    } catch (error) { next(error); }
  });

  router.post('/auth/login', authLimiter, async (request, response, next) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const identifier = parsed.data.identifier ?? parsed.data.email!;
      const user = await prisma.user.findFirst({
        where: identifier.includes('@') ? { email: identifier.toLowerCase() } : { phone: identifier },
        select: { ...safeUserSelect, passwordHash: true },
      });
      if (!user || user.status !== 'ACTIVE' || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
        response.status(401).json(apiError('INVALID_CREDENTIALS', 'The identifier or password is incorrect.'));
        return;
      }
      const { passwordHash: _passwordHash, ...publicUser } = user;
      void _passwordHash;
      response.status(200).json(apiSuccess({ user: publicUser, ...await issueSession(user.id, user.role) }));
    } catch (error) { next(error); }
  });

  router.post('/auth/refresh', authLimiter, async (request, response, next) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const tokenHash = hashRefreshToken(parsed.data.refreshToken, refreshSecret);
      const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });
      if (!existing) { response.status(401).json(apiError('INVALID_REFRESH_TOKEN', 'The refresh token is invalid.')); return; }
      if (existing.revokedAt || existing.expiresAt <= new Date()) {
        if (existing.revokedAt) await prisma.refreshToken.updateMany({ where: { userId: existing.userId, revokedAt: null }, data: { revokedAt: new Date() } });
        response.status(401).json(apiError('INVALID_REFRESH_TOKEN', 'The refresh token is expired or revoked.'));
        return;
      }
      const user = await prisma.user.findUnique({ where: { id: existing.userId }, select: { id: true, role: true, status: true } });
      if (!user || user.status !== 'ACTIVE') { response.status(401).json(apiError('INVALID_REFRESH_TOKEN', 'The account is unavailable.')); return; }
      const replacement = createRefreshToken();
      const replacementId = await prisma.$transaction(async tx => {
        const created = await tx.refreshToken.create({ data: {
          userId: user.id, tokenHash: hashRefreshToken(replacement, refreshSecret), expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        } });
        const updated = await tx.refreshToken.updateMany({
          where: { id: existing.id, revokedAt: null, expiresAt: { gt: new Date() } },
          data: { revokedAt: new Date(), replacedById: created.id },
        });
        if (updated.count !== 1) throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'The refresh token has already been used.');
        return created.id;
      });
      void replacementId;
      response.status(200).json(apiSuccess({
        accessToken: createAccessToken(user.id, user.role, accessSecret), refreshToken: replacement, tokenType: 'Bearer',
      }));
    } catch (error) { next(error); }
  });

  router.post('/auth/logout', authenticate, async (request, response, next) => {
    try {
      await prisma.refreshToken.updateMany({ where: { userId: request.auth!.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      response.status(200).json(apiSuccess({ loggedOut: true }));
    } catch (error) { next(error); }
  });

  router.get('/auth/me', authenticate, async (request, response, next) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: request.auth!.userId }, select: safeUserSelect });
      if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'The account was not found.');
      response.status(200).json(apiSuccess(user));
    } catch (error) { next(error); }
  });

  router.get('/users/me', authenticate, async (request, response, next) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: request.auth!.userId }, select: safeUserSelect });
      if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'The account was not found.');
      response.status(200).json(apiSuccess(user));
    } catch (error) { next(error); }
  });

  router.patch('/users/me', authenticate, async (request, response, next) => {
    const parsed = updateUserSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const { preferredSports } = parsed.data;
      const user = await prisma.$transaction(async tx => {
        if (preferredSports) {
          const found = await resolvePreferredSports(tx, preferredSports);
          await tx.userSport.deleteMany({ where: { userId: request.auth!.userId } });
          if (found.length) await tx.userSport.createMany({ data: found.map(sport => ({ userId: request.auth!.userId, sportId: sport.id })) });
        }
        return tx.user.update({
          where: { id: request.auth!.userId },
          data: {
            ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
            ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
          },
          select: safeUserSelect,
        });
      });
      response.status(200).json(apiSuccess(user));
    } catch (error) { next(error); }
  });

  router.get('/vendors/me', authenticate, requireRole('VENDOR'), async (request, response, next) => {
    try {
      const profile = await prisma.vendorProfile.findUnique({ where: { ownerUserId: request.auth!.userId } });
      if (!profile) throw new HttpError(404, 'VENDOR_PROFILE_NOT_FOUND', 'The vendor profile was not found.');
      response.status(200).json(apiSuccess(profile));
    } catch (error) { next(error); }
  });

  router.patch('/vendors/me', authenticate, requireRole('VENDOR'), async (request, response, next) => {
    const parsed = updateVendorSchema.safeParse(request.body);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const profile = await prisma.vendorProfile.update({
        where: { ownerUserId: request.auth!.userId },
        data: {
          ...(parsed.data.businessName !== undefined ? { businessName: parsed.data.businessName } : {}),
          ...(parsed.data.contactPhone !== undefined ? { contactPhone: parsed.data.contactPhone } : {}),
        },
      });
      response.status(200).json(apiSuccess(profile));
    } catch (error) { next(error); }
  });

  return router;
}
