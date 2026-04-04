import { defineStore } from "pinia";
import { ChannelChatSession } from "@/lib/channel-chat-session";

export const useChatStore = defineStore("chat", () => {
  const session = new ChannelChatSession();

  return {
    messages: session.messages,
    selectedClient: session.selectedClient,
    selectedConversationId: session.selectedConversationId,
    isStreaming: session.isStreaming,
    error: session.error,
    selectClient: session.selectClient.bind(session),
    sendMessage: session.sendMessage.bind(session),
    sendReminder: session.sendReminder.bind(session),
    clearMessages: session.clear.bind(session),
    destroy: session.destroy.bind(session),
  };
});
