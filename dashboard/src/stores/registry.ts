// Pinia store — registry agents state, driven by WebSocket events
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { RegistryAgent, WsMessage, ConnectionStatus } from "@/types";

const REGISTRY_WS = import.meta.env.VITE_REGISTRY_WS ?? "ws://localhost:4999/ws";
const MAX_RECONNECT_DELAY = 30_000;

export const useRegistryStore = defineStore("registry", () => {
  const agents = ref<Map<string, RegistryAgent>>(new Map());
  const status = ref<ConnectionStatus>("connecting");
  const lastEventAt = ref<string | null>(null);

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1_000;
  let destroyed = false;

  function connect() {
    if (destroyed) return;
    status.value = "connecting";

    ws = new WebSocket(REGISTRY_WS);

    ws.onopen = () => {
      status.value = "connected";
      reconnectDelay = 1_000;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WsMessage;
        handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!destroyed) {
        status.value = "disconnected";
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      status.value = "error";
      ws?.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer || destroyed) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, reconnectDelay);
  }

  function handleMessage(msg: WsMessage) {
    lastEventAt.value = new Date().toISOString();

    switch (msg.type) {
      case "snapshot": {
        const map = new Map<string, RegistryAgent>();
        for (const agent of msg.agents) {
          map.set(agent.agentId, agent);
        }
        agents.value = map;
        break;
      }
      case "agent.registered": {
        const updated = new Map(agents.value);
        updated.set(msg.data.agentId, msg.data);
        agents.value = updated;
        break;
      }
      case "agent.deregistered":
      case "agent.removed": {
        const updated = new Map(agents.value);
        updated.delete(msg.data.agentId);
        agents.value = updated;
        break;
      }
      case "agent.heartbeat": {
        const updated = new Map(agents.value);
        const agent = updated.get(msg.data.agentId);
        if (agent) {
          updated.set(msg.data.agentId, {
            ...agent,
            lastHeartbeat: typeof msg.data.timestamp === "number"
              ? msg.data.timestamp
              : Date.now(),
            healthy: true,
          });
          agents.value = updated;
        }
        break;
      }
      case "agent.unhealthy": {
        const updated = new Map(agents.value);
        const agent = updated.get(msg.data.agentId);
        if (agent) {
          updated.set(msg.data.agentId, { ...agent, healthy: false });
          agents.value = updated;
        }
        break;
      }
    }
  }

  // Computed
  const agentList = computed(() => Array.from(agents.value.values()));
  const clientList = computed(() => agentList.value.filter((a) => a.entryType === "client"));
  const runnableAgentList = computed(() => agentList.value.filter((a) => a.entryType !== "client"));
  const agentCount = computed(() => runnableAgentList.value.length);
  const clientCount = computed(() => clientList.value.length);
  const healthyCount = computed(() => runnableAgentList.value.filter((a) => a.healthy).length);

  function getAgent(id: string): RegistryAgent | undefined {
    return agents.value.get(id);
  }

  function disconnect() {
    destroyed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
  }

  // Start connection immediately
  connect();

  return {
    agents,
    agentList,
    clientList,
    runnableAgentList,
    agentCount,
    clientCount,
    healthyCount,
    status,
    lastEventAt,
    getAgent,
    disconnect,
  };
});
