import { Router, type Response } from 'express';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { apiError, apiSuccess } from '../../common/apiResponse.js';
import { HttpError } from '../../common/httpError.js';
import { requireAuth } from '../../middleware/auth.js';

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const readAllSchema = z.object({ conversationId: z.string().uuid().optional() }).strict();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface NotificationsRouterOptions { prisma: PrismaClient; accessSecret: string; }

function invalid(response: Response, issues: { path: PropertyKey[]; message: string }[]): void {
  response.status(400).json(apiError('VALIDATION_ERROR', 'The request is invalid.', issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))));
}

export function createNotificationsRouter({ prisma, accessSecret }: NotificationsRouterOptions): Router {
  const router = Router();
  const authenticate = requireAuth(prisma, accessSecret);

  router.get('/notifications', authenticate, async (request, response, next) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const { page, limit } = parsed.data;
      const where = { userId: request.auth!.userId };
      const [items, total] = await Promise.all([
        prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
        prisma.notification.count({ where }),
      ]);
      response.status(200).json(apiSuccess(items.map(item => ({
        id: item.id, userId: item.userId, type: item.type, title: item.title, body: item.body,
        payload: item.payload, readAt: item.readAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString(),
      })), { page, limit, total }));
    } catch (error) { next(error); }
  });

  router.patch('/notifications/:notificationId/read', authenticate, async (request, response, next) => {
    const notificationId = request.params.notificationId;
    if (typeof notificationId !== 'string' || !UUID.test(notificationId)) {
      response.status(400).json(apiError('INVALID_ID', 'notificationId must be a UUID.'));
      return;
    }
    try {
      const owned = await prisma.notification.findFirst({ where: { id: notificationId, userId: request.auth!.userId } });
      if (!owned) throw new HttpError(404, 'NOTIFICATION_NOT_FOUND', 'The notification was not found.');
      const readAt = owned.readAt ?? new Date();
      if (!owned.readAt) await prisma.notification.update({ where: { id: notificationId }, data: { readAt } });
      response.status(200).json(apiSuccess({ id: notificationId, readAt: readAt.toISOString() }));
    } catch (error) { next(error); }
  });

  router.post('/notifications/read-all', authenticate, async (request, response, next) => {
    const parsed = readAllSchema.safeParse(request.body ?? {});
    if (!parsed.success) { invalid(response, parsed.error.issues); return; }
    try {
      const userId = request.auth!.userId;
      const { conversationId } = parsed.data;
      if (conversationId) {
        const member = await prisma.conversationMember.findUnique({
          where: { conversationId_userId: { conversationId, userId } }, select: { conversationId: true },
        });
        if (!member) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', 'The conversation was not found.');
      }
      const where: Prisma.NotificationWhereInput = {
          userId, readAt: null,
          ...(conversationId ? { payload: { path: ['conversationId'], equals: conversationId } } : {}),
      };
      const result = await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
      response.status(200).json(apiSuccess({ updated: result.count }));
    } catch (error) { next(error); }
  });

  return router;
}
