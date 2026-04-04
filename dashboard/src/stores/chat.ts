import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { randomUUID } from "@/lib/utils";
import { createChannelMessage } from "@/lib/registry-client";
import type { ChannelAckPayload, ChannelMessagePayload, ChatMessage, RegistryAgent, WsMessage } from "@/types";

const REGISTRY_WS = import.meta.env.VITE_REGISTRY_WS ?? "ws://localhost:4999/ws";
const DASHBOARD_AGENT_ID = "dashboard-ui";
const DASHBOARD_AGENT_NAME = "Dashboard";

function toChatMessage(message: ChannelMessagePayload): ChatMessage {
  return {
    id: message.messageId,
    role: message.fromAgentId === DASHBOARD_AGENT_ID ? "user" : "agent",
    content: message.content,
    timestamp: new Date(message.createdAt).toISOString(),
    messageId: message.messageId,
    conversationId: message.conversationId,
    deliveryState: "queued",
  };
}

export const useChatStore = defineStore("chat", () => {
  const messages = ref<ChatMessage[]>([]);
  const selectedClient = ref<RegistryAgent | null>(null);
  const activeConversationId = ref<string | null>(null);
  const isStreaming = ref(false);
  const error = ref<string | null>(null);

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 2_000;
  let destroyed = false;

  function connect() {
    if (destroyed) return;
    ws = new WebSocket(REGISTRY_WS);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WsMessage;
        handleWsMessage(msg);
      } catch {
        // Ignore malformed frames
      }
    };

    ws.onclose = () => {
      if (!destroyed) scheduleReconnect();
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer || destroyed) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    }, reconnectDelay);
  }

  function handleWsMessage(msg: WsMessage) {
    if (msg.type === "channel.message") {
      handleChannelMessage(msg.data);
      return;
    }
    if (msg.type === "channel.ack") {
      handleChannelAck(msg.data);
    }
  }

  function handleChannelMessage(message: ChannelMessagePayload) {
    if (!selectedClient.value) return;

    const relatesToDashboardThread =
      (message.fromAgentId === DASHBOARD_AGENT_ID && message.toAgentId === selectedClient.value.agentId) ||
      (message.fromAgentId === selectedClient.value.agentId && message.toAgentId === DASHBOARD_AGENT_ID);

    if (!relatesToDashboardThread) return;

    if (activeConversationId.value && message.conversationId !== activeConversationId.value) {
      return;
    }

    if (!activeConversationId.value) {
      activeConversationId.value = message.conversationId;
    }

    upsertMessage(toChatMessage(message));
    isStreaming.value = false;
    error.value = null;
  }

  function handleChannelAck(ack: ChannelAckPayload) {
    if (!activeConversationId.value || ack.conversationId !== activeConversationId.value) return;

    const idx = messages.value.findIndex((message) => message.messageId === ack.messageId);
    if (idx !== -1) {
      const current = messages.value[idx];
      messages.value = [
        ...messages.value.slice(0, idx),
        { ...current, deliveryState: ack.state },
        ...messages.value.slice(idx + 1),
      ];
    }

    if (ack.state === "failed") {
      error.value = ack.detail ?? "Channel delivery failed.";
    }
  }

  function upsertMessage(message: ChatMessage) {
    const idx = message.messageId
      ? messages.value.findIndex((item) => item.messageId === message.messageId)
      : -1;

    if (idx === -1) {
      messages.value = [...messages.value, message];
      return;
    }

    messages.value = [
      ...messages.value.slice(0, idx),
      { ...messages.value[idx], ...message },
      ...messages.value.slice(idx + 1),
    ];
  }

  function selectClient(agent: RegistryAgent | null) {
    selectedClient.value = agent;
    activeConversationId.value = null;
    messages.value = [];
    error.value = null;
    isStreaming.value = false;
  }

  async function sendMessage(text: string) {
    if (!selectedClient.value || isStreaming.value || !text.trim()) return;

    isStreaming.value = true;
    error.value = null;

    const latestMessage = messages.value.at(-1);
    const replyTo = latestMessage?.messageId;

    try {
      const message = await createChannelMessage({
        conversationId: activeConversationId.value ?? undefined,
        replyTo,
        fromAgentId: DASHBOARD_AGENT_ID,
        fromAgentName: DASHBOARD_AGENT_NAME,
        toAgentId: selectedClient.value.agentId,
        kind: "chat",
        content: text.trim(),
        requiresAck: true,
        expectsResponse: true,
        expiresAt: Date.now() + 300_000,
        meta: {
          targetClientId: selectedClient.value.agentId,
          targetProject: selectedClient.value.projectPath,
          source: "dashboard-chat",
        },
      });

      activeConversationId.value = message.conversationId;
      upsertMessage({
        ...toChatMessage(message),
        deliveryState: "queued",
      });
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      messages.value = [
        ...messages.value,
        {
          id: randomUUID(),
          role: "system",
          content: `Channel send failed: ${error.value}`,
          timestamp: new Date().toISOString(),
        },
      ];
      isStreaming.value = false;
      return;
    }
  }

  function clearMessages() {
    messages.value = [];
    activeConversationId.value = null;
    error.value = null;
    isStreaming.value = false;
  }

  function destroy() {
    destroyed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
  }

  const selectedConversationId = computed(() => activeConversationId.value);

  connect();

  return {
    messages,
    selectedClient,
    selectedConversationId,
    isStreaming,
    error,
    selectClient,
    sendMessage,
    clearMessages,
    destroy,
  };
});
