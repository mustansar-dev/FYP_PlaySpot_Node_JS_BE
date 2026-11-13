import type { PrismaClient } from '../../generated/prisma/client.js';
import { HttpError } from '../../common/httpError.js';
import type { RealtimeHub } from '../../realtime/hub.js';

export async function sendMessage(prisma: PrismaClient, realtime: RealtimeHub, conversationId: string, senderUserId: string, body: string) {
  const message = await prisma.$transaction(async tx => {
    const member = await tx.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId: senderUserId } } });
    if (!member) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', 'The conversation was not found.');
    return tx.message.create({
      data: { conversationId, senderUserId, body },
      include: { sender: { select: { id: true, name: true } } },
    });
  });
  const dto = {
    id: message.id, conversationId: message.conversationId, senderUserId: message.senderUserId,
    senderName: message.sender.name, body: message.body, createdAt: message.createdAt.toISOString(),
  };
  realtime.publishMessage({ conversationId, message: dto });
  return dto;
}
