// Pinia store — task lifecycle trace events
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { randomUUID } from "@/lib/utils";
import { dashboardChannelRuntime } from "@/lib/channel-runtime";
import type { TraceEvent, WsMessage, TaskState, TraceEventKind } from "@/types";

const MAX_EVENTS = 500;

function normalizeClientLabel(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "claude-code") return "Claude Code";
  if (normalized === "claude") return "Claude";
  if (normalized === "codex" || normalized === "codex-cli") return "Codex";
  if (normalized === "gemini" || normalized === "gemini-cli") return "Gemini";
  if (normalized === "client-dashboard-ui" || normalized === "dashboard-ui") return "Dashboard";
  return value;
}

export interface TraceFilters {
  agentId?: string;
  skillId?: string;
  state?: TaskState;
  clientId?: string;
  kind?: TraceEventKind;
}

export const useTraceStore = defineStore("trace", () => {
  const events = ref<TraceEvent[]>([]);
  const filters = ref<TraceFilters>({});

  let unsubscribeRuntime: (() => void) | null = null;

  function handleRegistryMessage(msg: WsMessage) {
    if (msg.type === "task.update") {
      addEvent({
        id: randomUUID(),
        timestamp: msg.data.timestamp,
        agentId: msg.data.agentId,
        agentName: msg.data.agentName,
        taskId: msg.data.taskId,
        state: msg.data.state,
        skillId: msg.data.skillId,
        payload: msg.data.payload,
        clientId: msg.data.clientId,
        clientName: msg.data.clientName,
        expanded: false,
      });
    } else if (msg.type === "channel.message") {
      const meta = msg.data.meta ?? {};
      const targetClientId = typeof meta.targetClientId === "string" ? meta.targetClientId : msg.data.toAgentId;
      const targetClientName = typeof meta.targetClientName === "string"
        ? meta.targetClientName
        : typeof meta.targetClient === "string"
          ? meta.targetClient
          : undefined;
      addEvent({
        id: randomUUID(),
        timestamp: new Date(msg.data.createdAt).toISOString(),
        agentId: msg.data.fromAgentId,
        agentName: msg.data.fromAgentName ?? msg.data.fromAgentId,
        taskId: msg.data.taskId ?? msg.data.messageId,
        state: msg.data.expectsResponse ? "input-required" : "working",
        payload: msg.data,
        expanded: false,
        kind: "channel-message",
        conversationId: msg.data.conversationId,
        messageId: msg.data.messageId,
        replyTo: msg.data.replyTo,
        direction: msg.data.toAgentId ? "outgoing" : "incoming",
        clientId: targetClientId,
        clientName: typeof meta.targetProject === "string" ? meta.targetProject : undefined,
        clientLabel: normalizeClientLabel(targetClientName),
      });
    } else if (msg.type === "channel.ack") {
      addEvent({
        id: randomUUID(),
        timestamp: new Date(msg.data.timestamp).toISOString(),
        agentId: msg.data.actorId,
        agentName: msg.data.actorType,
        taskId: msg.data.messageId,
        state: msg.data.state === "failed" ? "failed" : msg.data.state === "answered" ? "completed" : "working",
        payload: msg.data,
        expanded: false,
        kind: "channel-ack",
        conversationId: msg.data.conversationId,
        messageId: msg.data.messageId,
        channelState: msg.data.state,
        clientLabel: normalizeClientLabel(msg.data.actorType === "client" ? msg.data.actorId : undefined),
      });
    }
  }

  function addEvent(event: TraceEvent) {
    const arr = [event, ...events.value];
    if (arr.length > MAX_EVENTS) arr.length = MAX_EVENTS;
    events.value = arr;
  }

  const filteredEvents = computed(() => {
    return events.value.filter((e) => {
      if (filters.value.agentId && e.agentId !== filters.value.agentId) return false;
      if (filters.value.skillId && e.skillId !== filters.value.skillId) return false;
      if (filters.value.state && e.state !== filters.value.state) return false;
      if (filters.value.clientId && e.clientId !== filters.value.clientId) return false;
      if (filters.value.kind && e.kind !== filters.value.kind) return false;
      return true;
    });
  });

  function setFilter(key: keyof TraceFilters, value: string | undefined) {
    filters.value = { ...filters.value, [key]: value || undefined };
  }

  function clearFilters() {
    filters.value = {};
  }

  function toggleExpanded(eventId: string) {
    const idx = events.value.findIndex((e) => e.id === eventId);
    if (idx !== -1) {
      events.value[idx] = { ...events.value[idx], expanded: !events.value[idx].expanded };
    }
  }

  function clearEvents() {
    events.value = [];
  }

  function addAgUiEvent(agUiEvent: {
    type: string;
    agentId: string;
    agentName: string;
    threadId: string;
    runId: string;
    stepName?: string;
    toolCallName?: string;
    toolCallArgs?: unknown;
  }) {
    const kindMap: Record<string, TraceEventKind> = {
      STEP_STARTED: "ag-ui-step",
      STEP_FINISHED: "ag-ui-step",
      TOOL_CALL_START: "ag-ui-tool",
      TOOL_CALL_END: "ag-ui-tool",
    };
    const kind = kindMap[agUiEvent.type] ?? "task";
    const stateMap: Record<string, TaskState> = {
      STEP_STARTED: "working",
      TOOL_CALL_START: "working",
      STEP_FINISHED: "completed",
      TOOL_CALL_END: "completed",
    };
    const state: TaskState = stateMap[agUiEvent.type] ?? "working";
    addEvent({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      agentId: agUiEvent.agentId,
      agentName: agUiEvent.agentName,
      taskId: agUiEvent.threadId,
      state,
      skillId: agUiEvent.toolCallName ?? agUiEvent.stepName,
      expanded: false,
      kind,
      stepName: agUiEvent.stepName,
      toolCallName: agUiEvent.toolCallName,
      toolCallArgs: agUiEvent.toolCallArgs,
    });
  }

  function destroy() {
    if (unsubscribeRuntime) {
      unsubscribeRuntime();
      unsubscribeRuntime = null;
    }
  }

  // Subscribe to the shared runtime instead of opening a second WebSocket
  unsubscribeRuntime = dashboardChannelRuntime.on('registry', (msg) => {
    try {
      handleRegistryMessage(msg);
    } catch (err) {
      console.warn('[trace-store] Error processing registry message:', err);
    }
  });

  return {
    events,
    filteredEvents,
    filters,
    setFilter,
    clearFilters,
    toggleExpanded,
    clearEvents,
    addAgUiEvent,
    destroy,
  };
});
