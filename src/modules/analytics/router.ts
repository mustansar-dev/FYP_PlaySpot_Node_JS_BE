import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { apiError, apiSuccess } from '../../common/apiResponse.js';
import { HttpError } from '../../common/httpError.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { getVendorAnalytics } from './service.js';
import { analyticsQuerySchema } from './schemas.js';

export function createAnalyticsRouter(options: { prisma: PrismaClient; accessSecret: string }): Router {
  const router = Router();
  router.get('/vendors/me/analytics', requireAuth(options.prisma, options.accessSecret), requireRole('VENDOR'), async (request, response, next) => {
    const parsed = analyticsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json(apiError('VALIDATION_ERROR', 'The request is invalid.', parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))));
      return;
    }
    try {
      const profile = await options.prisma.vendorProfile.findUnique({
        where: { ownerUserId: request.auth!.userId }, select: { createdAt: true },
      });
      if (!profile) throw new HttpError(404, 'VENDOR_PROFILE_NOT_FOUND', 'The vendor profile was not found.');
      const pktDate = (value: Date) => new Date(value.getTime() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const today = pktDate(new Date());
      const registeredOn = pktDate(profile.createdAt);
      if (parsed.data.to > today) throw new HttpError(400, 'ANALYTICS_FUTURE_RANGE', 'Analytics cannot include future dates.');
      if (parsed.data.from < registeredOn) throw new HttpError(400, 'ANALYTICS_BEFORE_REGISTRATION', `Analytics are available from your vendor registration date, ${registeredOn}.`, [{ field: 'from', registeredOn }]);
      const result = await getVendorAnalytics(options.prisma, request.auth!.userId, parsed.data.from, parsed.data.to);
      response.status(200).json(apiSuccess({ ...result, registeredOn }));
    } catch (error) { next(error); }
  });
  return router;
}
