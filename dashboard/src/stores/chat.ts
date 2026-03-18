// Pinia store — agent chat via native fetch SSE streaming
import { defineStore } from "pinia";
import { ref } from "vue";
import { randomUUID } from "@/lib/utils";
import type { ChatMessage, RegistryAgent } from "@/types";
import { useTraceStore } from "@/stores/trace";

// AG-UI event type strings (mirrors @ag-ui/core EventType)
const EV = {
  RUN_STARTED: "RUN_STARTED",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  STEP_STARTED: "STEP_STARTED",
  STEP_FINISHED: "STEP_FINISHED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
} as const;

export const useChatStore = defineStore("chat", () => {
  const messages = ref<ChatMessage[]>([]);
  const selectedAgent = ref<RegistryAgent | null>(null);
  const isStreaming = ref(false);
  const error = ref<string | null>(null);

  let abortController: AbortController | null = null;

  function selectAgent(agent: RegistryAgent | null) {
    abortController?.abort();
    abortController = null;
    selectedAgent.value = agent;
    messages.value = [];
    error.value = null;
    isStreaming.value = false;
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

    const agentId = selectedAgent.value.agentId;
    const agentName = selectedAgent.value.name;
    const threadId = randomUUID();
    const runId = randomUUID();
    const messageId = randomUUID();
    const traceStore = useTraceStore();

    const toolCallMsgMap = new Map<string, string>();

    abortController = new AbortController();

    try {
      // Use registry proxy (/agents/:id/ag-ui) to avoid cross-origin issues.
      // Vite dev proxy maps /agents → http://localhost:4999; production is same-origin.
      const response = await fetch(`/agents/${agentId}/ag-ui`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
        },
        body: JSON.stringify({
          threadId,
          runId,
          messages: [{ id: messageId, role: "user", content: text.trim() }],
          tools: [],
          context: [],
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines: events separated by \n\n, each line "data: {...}"
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;

            let evt: Record<string, unknown>;
            try {
              evt = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              continue;
            }

            const type = evt.type as string;

            switch (type) {
              case EV.TEXT_MESSAGE_CONTENT: {
                const delta = (evt.delta as string) ?? "";
                if (delta) updateMessageContent(agentMsgId, delta);
                break;
              }
              case EV.TEXT_MESSAGE_END: {
                setMessageStreaming(agentMsgId, false);
                break;
              }
              case EV.STEP_STARTED: {
                traceStore.addAgUiEvent({ type: "STEP_STARTED", agentId, agentName, threadId, runId, stepName: evt.stepName as string });
                break;
              }
              case EV.STEP_FINISHED: {
                traceStore.addAgUiEvent({ type: "STEP_FINISHED", agentId, agentName, threadId, runId, stepName: evt.stepName as string });
                break;
              }
              case EV.TOOL_CALL_START: {
                const toolCallId = evt.toolCallId as string;
                const toolCallName = evt.toolCallName as string;
                traceStore.addAgUiEvent({ type: "TOOL_CALL_START", agentId, agentName, threadId, runId, toolCallName });
                const toolMsgId = randomUUID();
                toolCallMsgMap.set(toolCallId, toolMsgId);
                const toolMsg: ChatMessage = {
                  id: toolMsgId,
                  role: "tool",
                  content: "",
                  timestamp: new Date().toISOString(),
                  streaming: true,
                  toolCall: { name: toolCallName, argsRaw: "", streaming: true },
                };
                messages.value = [...messages.value, toolMsg];
                break;
              }
              case EV.TOOL_CALL_ARGS: {
                const toolCallId = evt.toolCallId as string;
                const delta = (evt.delta as string) ?? "";
                const toolMsgId = toolCallMsgMap.get(toolCallId);
                if (toolMsgId) appendToolCallArgs(toolMsgId, delta);
                break;
              }
              case EV.TOOL_CALL_END: {
                const toolCallId = evt.toolCallId as string;
                const toolMsgId = toolCallMsgMap.get(toolCallId);
                if (toolMsgId) {
                  const toolMsg = messages.value.find((m) => m.id === toolMsgId);
                  traceStore.addAgUiEvent({ type: "TOOL_CALL_END", agentId, agentName, threadId, runId, toolCallName: toolMsg?.toolCall?.name, toolCallArgs: toolMsg?.toolCall?.args });
                  finalizeToolCall(toolMsgId);
                }
                break;
              }
              case EV.RUN_ERROR: {
                const msg = (evt.message as string) ?? "Unknown error";
                error.value = msg;
                setMessageStreaming(agentMsgId, false);
                updateMessageContent(agentMsgId, `Error: ${msg}`, true);
                break;
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      setMessageStreaming(agentMsgId, false);
      updateMessageContent(agentMsgId, `Error: ${msg}`, true);
    } finally {
      setMessageStreaming(agentMsgId, false);
      isStreaming.value = false;
      abortController = null;
    }
  }

  function updateMessageContent(id: string, delta: string, replace = false) {
    const idx = messages.value.findIndex((m) => m.id === id);
    if (idx !== -1) {
      const msg = messages.value[idx];
      const newContent = replace ? delta : msg.content + delta;
      messages.value = [
        ...messages.value.slice(0, idx),
        { ...msg, content: newContent },
        ...messages.value.slice(idx + 1),
      ];
    }
  }

  function setMessageStreaming(id: string, streaming: boolean) {
    const idx = messages.value.findIndex((m) => m.id === id);
    if (idx !== -1) {
      messages.value = [
        ...messages.value.slice(0, idx),
        { ...messages.value[idx], streaming },
        ...messages.value.slice(idx + 1),
      ];
    }
  }

  function appendToolCallArgs(id: string, delta: string) {
    const idx = messages.value.findIndex((m) => m.id === id);
    if (idx !== -1) {
      const msg = messages.value[idx];
      if (msg.toolCall) {
        messages.value = [
          ...messages.value.slice(0, idx),
          { ...msg, toolCall: { ...msg.toolCall, argsRaw: (msg.toolCall.argsRaw ?? "") + delta } },
          ...messages.value.slice(idx + 1),
        ];
      }
    }
  }

  function finalizeToolCall(id: string) {
    const idx = messages.value.findIndex((m) => m.id === id);
    if (idx !== -1) {
      const msg = messages.value[idx];
      if (msg.toolCall) {
        let args: unknown = undefined;
        try { args = JSON.parse(msg.toolCall.argsRaw ?? ""); } catch { /* keep undefined */ }
        messages.value = [
          ...messages.value.slice(0, idx),
          { ...msg, streaming: false, toolCall: { ...msg.toolCall, args, streaming: false } },
          ...messages.value.slice(idx + 1),
        ];
      }
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
