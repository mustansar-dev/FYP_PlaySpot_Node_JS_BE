import type { PrismaClient } from '../../generated/prisma/client.js';
import { HttpError } from '../../common/httpError.js';
import type { RealtimeHub } from '../../realtime/hub.js';

export async function sendMessage(prisma: PrismaClient, realtime: RealtimeHub, conversationId: string, senderUserId: string, body: string) {
  const result = await prisma.$transaction(async tx => {
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true, kind: true, title: true,
        gameRoom: { select: { id: true, title: true } }, venue: { select: { name: true } },
        members: { select: { userId: true } },
      },
    });
    if (!conversation || !conversation.members.some(member => member.userId === senderUserId)) {
      throw new HttpError(404, 'CONVERSATION_NOT_FOUND', 'The conversation was not found.');
    }
    const message = await tx.message.create({
      data: { conversationId, senderUserId, body },
      include: { sender: { select: { id: true, name: true } } },
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { updatedAt: message.createdAt } });
    const recipients = conversation.members.filter(member => member.userId !== senderUserId);
    const notificationTitle = conversation.kind === 'GAME_ROOM'
      ? `New message in ${conversation.gameRoom?.title || conversation.title}`
      : conversation.kind === 'VENUE_VENDOR'
        ? `New message about ${conversation.venue?.name || conversation.title}`
        : `New message in ${conversation.title}`;
    const notifications = await Promise.all(recipients.map(member => tx.notification.create({
      data: {
        userId: member.userId, type: 'CHAT', title: notificationTitle,
        body: `${message.sender.name} sent a message.`,
        payload: {
          conversationId, messageId: message.id,
          ...(conversation.kind === 'GAME_ROOM' && conversation.gameRoom ? { gameRoomId: conversation.gameRoom.id } : {}),
        },
      },
    })));
    return { message, notifications };
  });
  const message = result.message;
  const dto = {
    id: message.id, conversationId: message.conversationId, senderUserId: message.senderUserId,
    senderName: message.sender.name, body: message.body, createdAt: message.createdAt.toISOString(),
  };
  realtime.publishMessage({ conversationId, message: dto });
  result.notifications.forEach(notification => realtime.publishNotification({
    userId: notification.userId,
    notification: {
      id: notification.id, userId: notification.userId, type: notification.type,
      title: notification.title, body: notification.body, payload: notification.payload,
      readAt: notification.readAt?.toISOString() ?? null, createdAt: notification.createdAt.toISOString(),
    },
  }));
  return dto;
}
