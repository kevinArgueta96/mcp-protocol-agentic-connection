import type { ChannelAckPayload, ChannelMessagePayload, ChatMessage } from "@/types";

export interface DashboardClientProfile {
  id: string;
  acceptsDirectedMessage(message: ChannelMessagePayload, selfClientId: string): boolean;
  matchesClientConversation(message: ChannelMessagePayload, selfClientId: string, targetClientId: string): boolean;
  toChatMessage(message: ChannelMessagePayload, selfClientId: string): ChatMessage;
  applyAck(messages: ChatMessage[], ack: ChannelAckPayload, conversationId: string | null): ChatMessage[];
}

export const dashboardClientProfile: DashboardClientProfile = {
  id: "dashboard",

  acceptsDirectedMessage(message, selfClientId) {
    return message.toAgentId === selfClientId || message.fromAgentId === selfClientId;
  },

  matchesClientConversation(message, selfClientId, targetClientId) {
    return (
      (message.fromAgentId === selfClientId && message.toAgentId === targetClientId) ||
      (message.fromAgentId === targetClientId && message.toAgentId === selfClientId)
    );
  },

  toChatMessage(message, selfClientId) {
    return {
      id: message.messageId,
      role: message.fromAgentId === selfClientId ? "user" : "agent",
      content: message.content,
      timestamp: new Date(message.createdAt).toISOString(),
      messageId: message.messageId,
      conversationId: message.conversationId,
      deliveryState: "queued",
    };
  },

  applyAck(messages, ack, conversationId) {
    if (!conversationId || ack.conversationId !== conversationId) return messages;
    const idx = messages.findIndex((message) => message.messageId === ack.messageId);
    if (idx === -1) return messages;
    return [
      ...messages.slice(0, idx),
      { ...messages[idx], deliveryState: ack.state },
      ...messages.slice(idx + 1),
    ];
  },
};
