import { EventEmitter } from 'node:events';

export interface ChatMessageEvent {
  conversationId: string;
  message: { id: string; conversationId: string; senderUserId: string; senderName: string; body: string; createdAt: string };
}

export class RealtimeHub extends EventEmitter {
  publishMessage(event: ChatMessageEvent): void { this.emit('chat:message:new', event); }
}
