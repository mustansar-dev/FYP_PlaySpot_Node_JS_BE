import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { apiError, apiSuccess } from '../../common/apiResponse.js';
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
      const result = await getVendorAnalytics(options.prisma, request.auth!.userId, parsed.data.from, parsed.data.to);
      response.status(200).json(apiSuccess(result));
    } catch (error) { next(error); }
  });
  return router;
}
