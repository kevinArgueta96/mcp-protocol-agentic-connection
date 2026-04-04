import { randomUUID } from "node:crypto";
import type {
  ChannelAck,
  ChannelConversationListEntry,
  ChannelConversationSnapshot,
  ChannelMessage,
} from "../types/messages.js";

export class ChannelStore {
  private messagesByConversation = new Map<string, ChannelMessage[]>();
  private acksByConversation = new Map<string, ChannelAck[]>();

  createMessage(input: Omit<ChannelMessage, "conversationId" | "messageId" | "createdAt"> & {
    conversationId?: string;
    messageId?: string;
    createdAt?: number;
  }): ChannelMessage {
    const message: ChannelMessage = {
      ...input,
      conversationId: input.conversationId ?? randomUUID(),
      messageId: input.messageId ?? randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
      attemptCount: input.attemptCount ?? 1,
    };

    const messages = this.messagesByConversation.get(message.conversationId) ?? [];
    messages.push(message);
    this.messagesByConversation.set(message.conversationId, messages);
    return message;
  }

  addAck(ack: ChannelAck): ChannelAck {
    const acks = this.acksByConversation.get(ack.conversationId) ?? [];
    acks.push(ack);
    this.acksByConversation.set(ack.conversationId, acks);
    return ack;
  }

  getConversation(conversationId: string): ChannelConversationSnapshot | undefined {
    const messages = this.messagesByConversation.get(conversationId);
    if (!messages) return undefined;

    return {
      conversationId,
      messages: [...messages],
      acknowledgements: [...(this.acksByConversation.get(conversationId) ?? [])],
    };
  }

  listConversations(filter?: { pendingOnly?: boolean }): ChannelConversationListEntry[] {
    const entries: ChannelConversationListEntry[] = [];
    const now = Date.now();

    for (const [conversationId, messages] of this.messagesByConversation.entries()) {
      const lastMessage = messages[messages.length - 1];
      if (!lastMessage) continue;
      const acks = this.acksByConversation.get(conversationId) ?? [];
      const lastAckForMessage = [...acks].reverse().find((ack) => ack.messageId === lastMessage.messageId);
      const answered = acks.some((ack) => ack.messageId === lastMessage.messageId && ack.state === "answered");
      const expired = typeof lastMessage.expiresAt === "number" && lastMessage.expiresAt <= now;
      const pendingReply = lastMessage.expectsResponse === true && !answered && !expired;

      if (filter?.pendingOnly && !pendingReply) continue;

      entries.push({
        conversationId,
        lastMessage,
        pendingReply,
        expired,
        lastAckState: lastAckForMessage?.state,
      });
    }

    return entries.sort((a, b) => b.lastMessage.createdAt - a.lastMessage.createdAt);
  }

  retryMessage(conversationId: string, messageId: string): ChannelMessage | undefined {
    const messages = this.messagesByConversation.get(conversationId);
    if (!messages) return undefined;

    const index = messages.findIndex((message) => message.messageId === messageId);
    if (index === -1) return undefined;

    const current = messages[index];
    const retried: ChannelMessage = {
      ...current,
      attemptCount: (current.attemptCount ?? 1) + 1,
      createdAt: Date.now(),
    };
    messages[index] = retried;
    this.messagesByConversation.set(conversationId, messages);
    return retried;
  }
}
