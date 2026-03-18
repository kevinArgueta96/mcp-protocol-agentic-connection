// Pinia store — task lifecycle trace events
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { randomUUID } from "@/lib/utils";
import type { TraceEvent, WsMessage, TaskState } from "@/types";

const REGISTRY_WS = import.meta.env.VITE_REGISTRY_WS ?? "ws://localhost:4999/ws";
const MAX_EVENTS = 500;

export interface TraceFilters {
  agentId?: string;
  skillId?: string;
  state?: TaskState;
}

export const useTraceStore = defineStore("trace", () => {
  const events = ref<TraceEvent[]>([]);
  const filters = ref<TraceFilters>({});

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
            expanded: false,
          });
        }
      } catch {
        // Ignore
      }
    };

    ws.onclose = () => {
      if (!destroyed) scheduleReconnect();
    };

    ws.onerror = () => { ws?.close(); };
  }

  function scheduleReconnect() {
    if (reconnectTimer || destroyed) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    }, reconnectDelay);
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

  function destroy() {
    destroyed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    ws?.close();
    ws = null;
  }

  // Start connection immediately
  connect();

  return {
    events,
    filteredEvents,
    filters,
    setFilter,
    clearFilters,
    toggleExpanded,
    clearEvents,
    destroy,
  };
});