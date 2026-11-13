import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { PrismaClient } from '../generated/prisma/client.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { messageCreateSchema } from '../modules/community/schemas.js';
import { sendMessage } from '../modules/community/chatService.js';
import type { RealtimeHub } from './hub.js';

declare module 'socket.io' {
  interface SocketData { userId: string; role: 'PLAYER' | 'VENDOR'; }
}

function ack(socket: Socket, callback: unknown, payload: unknown): void {
  if (typeof callback === 'function') (callback as (value: unknown) => void)(payload);
  else socket.emit('chat:error', payload);
}

function socketToken(socket: Socket): string | undefined {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken.length > 0) return authToken.replace(/^Bearer\s+/i, '');
  const authorization = socket.handshake.headers.authorization;
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
}

export function attachSocketServer(input: {
  server: HttpServer; prisma: PrismaClient; accessSecret: string; allowedOrigins: string[]; realtime: RealtimeHub;
}): Server {
  const io = new Server(input.server, { cors: { origin: input.allowedOrigins, credentials: true } });
  io.use(async (socket, next) => {
    const token = socketToken(socket);
    const claims = token ? verifyAccessToken(token, input.accessSecret) : undefined;
    if (!claims) { next(new Error('UNAUTHORIZED')); return; }
    try {
      const user = await input.prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true, role: true, status: true } });
      if (!user || user.status !== 'ACTIVE') { next(new Error('UNAUTHORIZED')); return; }
      socket.data.userId = user.id;
      socket.data.role = user.role;
      next();
    } catch { next(new Error('UNAUTHORIZED')); }
  });

  io.on('connection', socket => {
    socket.on('chat:join', async (payload: unknown, callback?: unknown) => {
      const conversationId = typeof payload === 'object' && payload !== null && 'conversationId' in payload
        ? (payload as { conversationId?: unknown }).conversationId : undefined;
      if (typeof conversationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) {
        ack(socket, callback, { success: false, error: { code: 'INVALID_CONVERSATION_ID' } });
        return;
      }
      try {
        const membership = await input.prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId: socket.data.userId } }, select: { conversationId: true } });
        if (!membership) { ack(socket, callback, { success: false, error: { code: 'CONVERSATION_FORBIDDEN' } }); return; }
        await socket.join(`conversation:${conversationId}`);
        ack(socket, callback, { success: true, data: { conversationId } });
      } catch {
        ack(socket, callback, { success: false, error: { code: 'JOIN_FAILED' } });
      }
    });

    socket.on('chat:message', async (payload: unknown, callback?: unknown) => {
      const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
      const parsed = messageCreateSchema.safeParse({ body: record.body });
      if (!parsed.success || typeof record.conversationId !== 'string') {
        ack(socket, callback, { success: false, error: { code: 'VALIDATION_ERROR' } });
        return;
      }
      try {
        const message = await sendMessage(input.prisma, input.realtime, record.conversationId, socket.data.userId, parsed.data.body);
        ack(socket, callback, { success: true, data: message });
      } catch {
        ack(socket, callback, { success: false, error: { code: 'MESSAGE_NOT_SENT' } });
      }
    });
  });

  input.realtime.on('chat:message:new', (event: { conversationId: string; message: unknown }) => {
    io.to(`conversation:${event.conversationId}`).emit('chat:message:new', event.message);
  });
  return io;
}
