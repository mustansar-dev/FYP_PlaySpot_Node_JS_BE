import { EventEmitter } from 'node:events';

export interface ChatMessageEvent {
  conversationId: string;
  message: { id: string; conversationId: string; senderUserId: string; senderName: string; body: string; createdAt: string };
}

export interface NotificationEvent {
  userId: string;
  notification: { id: string; userId: string; type: string; title: string; body: string; payload: unknown; readAt: string | null; createdAt: string };
}

export class RealtimeHub extends EventEmitter {
  publishMessage(event: ChatMessageEvent): void { this.emit('chat:message:new', event); }
  publishNotification(event: NotificationEvent): void { this.emit('notification:new', event); }
}
