// Pinia store — agent chat via AG-UI HTTP streaming
import { defineStore } from "pinia";
import { ref } from "vue";
import { randomUUID } from "@/lib/utils";
import type { ChatMessage, RegistryAgent } from "@/types";

export const useChatStore = defineStore("chat", () => {
  const messages = ref<ChatMessage[]>([]);
  const selectedAgent = ref<RegistryAgent | null>(null);
  const isStreaming = ref(false);
  const error = ref<string | null>(null);

  function selectAgent(agent: RegistryAgent | null) {
    selectedAgent.value = agent;
    messages.value = [];
    error.value = null;
  }

  async function sendMessage(text: string) {
    if (!selectedAgent.value || isStreaming.value || !text.trim()) return;

    error.value = null;
    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: text.trim(),
      timestamp: new Date().toISOString(),
    };
    messages.value = [...messages.value, userMsg];

    const agentMsgId = randomUUID();
    const agentMsg: ChatMessage = {
      id: agentMsgId,
      role: "agent",
      content: "",
      timestamp: new Date().toISOString(),
      streaming: true,
    };
    messages.value = [...messages.value, agentMsg];
    isStreaming.value = true;

    try {
      // Send via A2A JSON-RPC to the agent URL
      const agentUrl = selectedAgent.value.url;
      const response = await fetch(agentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tasks/send",
          params: {
            message: {
              role: "user",
              parts: [{ type: "text", text: text.trim() }],
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as {
        result?: {
          status?: { state: string };
          artifacts?: Array<{
            parts: Array<{ type: string; text?: string; data?: unknown }>;
          }>;
        };
        error?: { message: string };
      };

      if (data.error) {
        throw new Error(data.error.message);
      }

      let content = "";
      if (data.result?.artifacts?.length) {
        for (const artifact of data.result.artifacts) {
          for (const part of artifact.parts) {
            if (part.type === "text" && part.text) {
              content += part.text;
            } else if (part.type === "data" && part.data) {
              content += JSON.stringify(part.data, null, 2);
            }
          }
        }
      } else {
        content = `Task ${data.result?.status?.state ?? "completed"}`;
      }

      updateMessage(agentMsgId, content, false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      updateMessage(agentMsgId, `Error: ${msg}`, false);
    } finally {
      isStreaming.value = false;
    }
  }

  function updateMessage(id: string, content: string, streaming: boolean) {
    const idx = messages.value.findIndex((m) => m.id === id);
    if (idx !== -1) {
      messages.value = [
        ...messages.value.slice(0, idx),
        { ...messages.value[idx], content, streaming },
        ...messages.value.slice(idx + 1),
      ];
    }
  }

  function clearMessages() {
    messages.value = [];
    error.value = null;
  }

  return {
    messages,
    selectedAgent,
    isStreaming,
    error,
    selectAgent,
    sendMessage,
    clearMessages,
  };
});
