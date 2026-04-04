// Pinia store — registry agents state, driven by WebSocket events
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { RegistryAgent, WsMessage, ConnectionStatus } from "@/types";
import { deregisterClient, registerClient, sendClientHeartbeat } from "@/lib/registry-client";

const REGISTRY_WS = import.meta.env.VITE_REGISTRY_WS ?? "ws://localhost:4999/ws";
const MAX_RECONNECT_DELAY = 30_000;
const DASHBOARD_CLIENT_ID = "client-dashboard-ui";
const DASHBOARD_PROJECT_NAME = "dashboard";
const DASHBOARD_PROJECT_PATH = typeof window !== "undefined"
  ? `${window.location.origin}/dashboard`
  : "dashboard://local";

export const useRegistryStore = defineStore("registry", () => {
  const agents = ref<Map<string, RegistryAgent>>(new Map());
  const status = ref<ConnectionStatus>("connecting");
  const lastEventAt = ref<string | null>(null);
  const dashboardClientId = ref<string>(DASHBOARD_CLIENT_ID);

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1_000;
  let destroyed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let registered = false;

  function connect() {
    if (destroyed) return;
    status.value = "connecting";

    ws = new WebSocket(REGISTRY_WS);

    ws.onopen = () => {
      status.value = "connected";
      reconnectDelay = 1_000;
      ws?.send(JSON.stringify({ type: "identify", agentId: dashboardClientId.value }));
      void ensureDashboardClientRegistered();
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

  async function ensureDashboardClientRegistered() {
    try {
      await registerClient({
        agentId: dashboardClientId.value,
        name: DASHBOARD_PROJECT_NAME,
        url: "",
        wsUrl: "",
        port: 0,
        projectPath: DASHBOARD_PROJECT_PATH,
        projectName: DASHBOARD_PROJECT_NAME,
        projectType: "unknown",
        registeredAt: Date.now(),
        lastHeartbeat: Date.now(),
        healthy: true,
        entryType: "client",
        clientInfo: {
          clientName: "dashboard",
          clientVersion: "web",
        },
        card: {
          name: DASHBOARD_PROJECT_NAME,
          description: "Dashboard web client for agent-bridge channels",
          url: "",
          version: "web",
          capabilities: {
            streaming: false,
            pushNotifications: false,
            stateTransitionHistory: false,
          },
          skills: [],
        },
      });
      registered = true;
      startHeartbeat();
    } catch {
      // Ignore registration retries; next reconnect or heartbeat will try again.
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!registered) {
        void ensureDashboardClientRegistered();
        return;
      }
      void sendClientHeartbeat(dashboardClientId.value).catch(() => {
        registered = false;
      });
    }, 30_000);
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
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    ws?.close();
    ws = null;
    if (registered) {
      void deregisterClient(dashboardClientId.value);
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      if (!registered) return;
      void fetch(`${import.meta.env.VITE_REGISTRY_URL ?? "http://localhost:4999"}/agents/${encodeURIComponent(dashboardClientId.value)}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => undefined);
    });
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
    dashboardClientId,
    status,
    lastEventAt,
    getAgent,
    disconnect,
  };
});
