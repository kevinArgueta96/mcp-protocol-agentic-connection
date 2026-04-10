// Pinia store — registry agents state, driven by WebSocket events
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { RegistryAgent, WsMessage, ConnectionStatus } from "@/types";
import { dashboardChannelRuntime } from "@/lib/channel-runtime";

export const useRegistryStore = defineStore("registry", () => {
  const agents = ref<Map<string, RegistryAgent>>(new Map());
  const status = ref<ConnectionStatus>("connecting");
  const lastEventAt = ref<string | null>(null);
  const dashboardClientId = ref<string>(dashboardChannelRuntime.clientId);

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
        const newAgent = msg.data;
        // Remove stale entries for the same logical entity before inserting
        for (const [id, existing] of updated) {
          if (id === newAgent.agentId) continue;
          const sameClient =
            newAgent.entryType === "client" &&
            existing.entryType === "client" &&
            existing.projectPath === newAgent.projectPath &&
            existing.clientInfo?.clientName === newAgent.clientInfo?.clientName;
          const sameAgent =
            newAgent.entryType !== "client" &&
            existing.entryType !== "client" &&
            existing.projectPath === newAgent.projectPath;
          if (sameClient || sameAgent) {
            updated.delete(id);
          }
        }
        updated.set(newAgent.agentId, newAgent);
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
    void dashboardChannelRuntime.destroy();
  }

  dashboardChannelRuntime.on("status", (nextStatus) => {
    status.value = nextStatus;
  });

  dashboardChannelRuntime.on("registry", (msg) => {
    handleMessage(msg);
  });

  dashboardChannelRuntime.start();

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
