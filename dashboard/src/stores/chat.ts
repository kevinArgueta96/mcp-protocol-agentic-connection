// Pinia store — agent chat via AG-UI HTTP streaming
import { defineStore } from "pinia";
import { ref } from "vue";
import { randomUUID } from "@/lib/utils";
import type { ChatMessage, RegistryAgent } from "@/types";
import { HttpAgent, EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import { useTraceStore } from "@/stores/trace";

export const useChatStore = defineStore("chat", () => {
  const messages = ref<ChatMessage[]>([]);
  const selectedAgent = ref<RegistryAgent | null>(null);
  const isStreaming = ref(false);
  const error = ref<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let activeSubscription: { unsubscribe(): void } | null = null;

  function selectAgent(agent: RegistryAgent | null) {
    activeSubscription?.unsubscribe();
    activeSubscription = null;
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

    const agentUrl = selectedAgent.value.url;
    const agentId = selectedAgent.value.agentId;
    const agentName = selectedAgent.value.name;
    const threadId = randomUUID();
    const runId = randomUUID();
    const messageId = randomUUID();
    const traceStore = useTraceStore();

    // Track tool call message IDs (toolCallId → message id in messages array)
    const toolCallMsgMap = new Map<string, string>();

    const agent = new HttpAgent({ url: `${agentUrl}/ag-ui` });

    const observable = agent.run({
      threadId,
      runId,
      messages: [{ id: messageId, role: "user" as const, content: text.trim() }],
      tools: [],
      context: [],
    });

    activeSubscription = observable.subscribe({
      next(event: BaseEvent) {
        const e = event as BaseEvent & Record<string, unknown>;

        switch (e.type) {
          case EventType.TEXT_MESSAGE_CONTENT: {
            const delta = (e.delta as string) ?? "";
            updateMessageContent(agentMsgId, delta);
            break;
          }
          case EventType.TEXT_MESSAGE_END: {
            setMessageStreaming(agentMsgId, false);
            break;
          }
          case EventType.STEP_STARTED: {
            traceStore.addAgUiEvent({ type: "STEP_STARTED", agentId, agentName, threadId, runId, stepName: e.stepName as string });
            break;
          }
          case EventType.STEP_FINISHED: {
            traceStore.addAgUiEvent({ type: "STEP_FINISHED", agentId, agentName, threadId, runId, stepName: e.stepName as string });
            break;
          }
          case EventType.TOOL_CALL_START: {
            const toolCallId = e.toolCallId as string;
            const toolCallName = e.toolCallName as string;
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
          case EventType.TOOL_CALL_ARGS: {
            const toolCallId = e.toolCallId as string;
            const delta = (e.delta as string) ?? "";
            const toolMsgId = toolCallMsgMap.get(toolCallId);
            if (toolMsgId) appendToolCallArgs(toolMsgId, delta);
            break;
          }
          case EventType.TOOL_CALL_END: {
            const toolCallId = e.toolCallId as string;
            const toolMsgId = toolCallMsgMap.get(toolCallId);
            if (toolMsgId) {
              const toolMsg = messages.value.find((m) => m.id === toolMsgId);
              traceStore.addAgUiEvent({ type: "TOOL_CALL_END", agentId, agentName, threadId, runId, toolCallName: toolMsg?.toolCall?.name, toolCallArgs: toolMsg?.toolCall?.args });
              finalizeToolCall(toolMsgId);
            }
            break;
          }
          case EventType.RUN_ERROR: {
            const msg = (e.message as string) ?? "Unknown error";
            error.value = msg;
            setMessageStreaming(agentMsgId, false);
            updateMessageContent(agentMsgId, `Error: ${msg}`, true);
            break;
          }
        }
      },
      error(err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        error.value = msg;
        setMessageStreaming(agentMsgId, false);
        updateMessageContent(agentMsgId, `Error: ${msg}`, true);
        isStreaming.value = false;
      },
      complete() {
        setMessageStreaming(agentMsgId, false);
        isStreaming.value = false;
      },
    });
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
