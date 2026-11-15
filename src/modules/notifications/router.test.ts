import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createAccessToken } from '../auth/tokens.js';
import { createNotificationsRouter } from './router.js';

const accessSecret = 'notification-test-access-secret-long-enough';
const userId = '11111111-1111-4111-8111-111111111111';
const conversationId = '33333333-3333-4333-8333-333333333333';
const notificationId = '44444444-4444-4444-8444-444444444444';

function setup() {
  const notification = {
    id: notificationId, userId, type: 'CHAT', title: 'New message in Room A', body: 'A player sent a message.',
    payload: { conversationId, messageId: '55555555-5555-4555-8555-555555555555' },
    readAt: null, createdAt: new Date('2026-11-15T10:00:00.000Z'),
  };
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ id: userId, role: 'PLAYER', status: 'ACTIVE' })) },
    notification: {
      findMany: vi.fn(async () => [notification]), count: vi.fn(async () => 1),
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) => where.userId === userId ? notification : null),
      update: vi.fn(async ({ data }: { data: { readAt: Date } }) => ({ ...notification, ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    conversationMember: { findUnique: vi.fn(async () => ({ conversationId })) },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createNotificationsRouter({ prisma: prisma as unknown as PrismaClient, accessSecret }));
  app.use(errorHandler);
  const token = createAccessToken(userId, 'PLAYER', accessSecret);
  return { app, token, prisma };
}

describe('notification routes', () => {
  it('lists only the authenticated user’s notifications with bounded pagination', async () => {
    const { app, token, prisma } = setup();
    const response = await request(app).get('/api/v1/notifications?page=1&limit=10').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({ id: notificationId, userId, type: 'CHAT', readAt: null });
    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId }, take: 10 }));
  });

  it('marks a notification as read only when it belongs to the caller', async () => {
    const { app, token, prisma } = setup();
    await request(app).patch(`/api/v1/notifications/${notificationId}/read`).set('Authorization', `Bearer ${token}`).expect(200);

    expect(prisma.notification.findFirst).toHaveBeenCalledWith({ where: { id: notificationId, userId } });
    expect(prisma.notification.update).toHaveBeenCalledWith({ where: { id: notificationId }, data: { readAt: expect.any(Date) } });
  });

  it('requires conversation membership when clearing chat notifications for one conversation', async () => {
    const { app, token, prisma } = setup();
    await request(app).post('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${token}`).send({ conversationId }).expect(200);

    expect(prisma.conversationMember.findUnique).toHaveBeenCalledWith({
      where: { conversationId_userId: { conversationId, userId } }, select: { conversationId: true },
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId, readAt: null, payload: { path: ['conversationId'], equals: conversationId } },
    }));
  });

  it('rejects requests without a valid JWT', async () => {
    const { app } = setup();
    await request(app).get('/api/v1/notifications').expect(401);
  });
});
