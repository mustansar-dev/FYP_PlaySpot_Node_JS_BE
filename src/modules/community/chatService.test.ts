import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { HttpError } from '../../common/httpError.js';
import { RealtimeHub } from '../../realtime/hub.js';
import { sendMessage } from './chatService.js';

const conversationId = '11111111-1111-4111-8111-111111111111';
const senderId = '22222222-2222-4222-8222-222222222222';
const recipientId = '33333333-3333-4333-8333-333333333333';
const messageId = '44444444-4444-4444-8444-444444444444';

function setup(options: { senderIsMember?: boolean; kind?: 'GAME_ROOM' | 'VENUE_VENDOR' } = {}) {
  const writes: string[] = [];
  let notificationIndex = 0;
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    conversation: {
      findUnique: vi.fn(async () => options.senderIsMember === false ? null : ({
        id: conversationId, kind: options.kind ?? 'GAME_ROOM', title: 'Evening Badminton',
        gameRoom: { id: '55555555-5555-4555-8555-555555555555', title: 'Evening Badminton' },
        venue: null, members: [{ userId: senderId }, { userId: recipientId }],
      })),
      update: vi.fn(async () => { writes.push('conversation-updated'); return {}; }),
    },
    message: {
      create: vi.fn(async () => {
        writes.push('message-created');
        return {
          id: messageId, conversationId, senderUserId: senderId, body: 'Ready to play?',
          createdAt: new Date('2026-11-15T10:00:00.000Z'), sender: { id: senderId, name: 'A Player' },
        };
      }),
    },
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push('notification-created');
        notificationIndex += 1;
        return {
          id: `66666666-6666-4666-8666-66666666666${notificationIndex}`,
          userId: data.userId, type: data.type, title: data.title, body: data.body,
          payload: data.payload, readAt: null, createdAt: new Date('2026-11-15T10:00:00.000Z'),
        };
      }),
    },
  };
  const realtime = new RealtimeHub();
  return { prisma, realtime, writes };
}

describe('persisted chat notifications', () => {
  it('persists a message and a private room notification for each other member before broadcasting', async () => {
    const { prisma, realtime, writes } = setup();
    const messageEvents: unknown[] = [];
    const notificationEvents: unknown[] = [];
    realtime.on('chat:message:new', event => messageEvents.push(event));
    realtime.on('notification:new', event => notificationEvents.push(event));

    const message = await sendMessage(prisma as unknown as PrismaClient, realtime, conversationId, senderId, 'Ready to play?');

    expect(message.senderUserId).toBe(senderId);
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(writes.indexOf('message-created')).toBeLessThan(writes.indexOf('notification-created'));
    expect(notificationEvents).toHaveLength(1);
    expect(notificationEvents[0]).toMatchObject({ userId: recipientId, notification: { title: 'New message in Evening Badminton', payload: { conversationId, gameRoomId: '55555555-5555-4555-8555-555555555555', messageId } } });
    expect(messageEvents).toHaveLength(1);
  });

  it('does not persist or broadcast messages from non-members', async () => {
    const { prisma, realtime } = setup({ senderIsMember: false });
    const messageEvents = vi.fn();
    const notificationEvents = vi.fn();
    realtime.on('chat:message:new', messageEvents);
    realtime.on('notification:new', notificationEvents);

    await expect(sendMessage(prisma as unknown as PrismaClient, realtime, conversationId, senderId, 'Unauthorized')).rejects.toBeInstanceOf(HttpError);

    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(messageEvents).not.toHaveBeenCalled();
    expect(notificationEvents).not.toHaveBeenCalled();
  });
});
