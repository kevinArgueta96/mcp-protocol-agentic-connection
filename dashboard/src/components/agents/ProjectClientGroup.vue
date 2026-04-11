<template>
  <div class="project-group" :class="{ 'project-group--degraded': !allHealthy, 'project-group--selected': hasSelectedClient }">
    <div class="project-group__head" @click="expanded = !expanded">
      <span
        class="group-health-dot"
        :class="allHealthy ? 'pulse-healthy' : 'pulse-error'"
        :style="{ background: allHealthy ? 'var(--emerald)' : 'var(--amber)' }"
      />
      <span class="group-name" :title="projectPath">{{ projectName }}</span>
      <div class="group-type-badges">
        <span v-for="type in uniqueClientTypes" :key="type" class="chip chip-violet chip--nano">
          {{ CLIENT_SHORT[type] ?? type }}
        </span>
      </div>
      <span class="group-count">{{ clients.length }}</span>
      <span class="group-toggle">{{ expanded ? '−' : '+' }}</span>
    </div>

    <div v-if="expanded" class="group-client-list">
      <button
        v-for="client in clients"
        :key="client.agentId"
        class="group-client-row"
        :class="{ 'group-client-row--active': selectedClientId === client.agentId }"
        @click.stop="onSelectClient(client)"
      >
        <span
          class="client-dot"
          :style="{ background: (client.healthy ?? false) ? 'var(--emerald)' : 'var(--red)' }"
        />
        <span class="client-label">{{ getClientLabel(client) }}</span>
        <span class="client-version">{{ client.clientInfo?.clientVersion ?? '' }}</span>
        <span class="client-time">{{ formatRelativeTime(client.lastHeartbeat) }}</span>
      </button>
    </div>

    <div class="group-footer">
      <span class="group-path">{{ projectPath }}</span>
      <span v-if="!expanded && hasSelectedClient" class="group-selected-hint">
        ● {{ selectedClientLabel }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useChatStore } from "@/stores/chat";
import type { RegistryAgent } from "@/types";

const CLIENT_SHORT: Record<string, string> = {
  "claude-code": "CC",
  "claude":      "Claude",
  "codex":       "Codex",
  "codex-cli":   "Codex",
  "gemini-cli":  "Gemini",
  "gemini":      "Gemini",
  "cursor":      "Cursor",
  "copilot":     "Copilot",
};

const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude":      "Claude",
  "codex":       "Codex CLI",
  "codex-cli":   "Codex CLI",
  "gemini-cli":  "Gemini CLI",
  "gemini":      "Gemini",
  "cursor":      "Cursor",
  "copilot":     "Copilot",
};

const props = defineProps<{
  projectName: string;
  projectPath: string;
  clients: RegistryAgent[];
}>();

const chatStore = useChatStore();
const expanded = ref(false);

const allHealthy = computed(() => props.clients.every((c) => c.healthy !== false));
const uniqueClientTypes = computed(() => {
  const types = new Set(props.clients.map((c) => c.clientInfo?.clientName ?? "unknown"));
  return Array.from(types);
});
const selectedClientId = computed(() => chatStore.selectedClient?.agentId ?? null);
const hasSelectedClient = computed(() =>
  props.clients.some((c) => c.agentId === selectedClientId.value),
);
const selectedClientLabel = computed(() => {
  const client = props.clients.find((c) => c.agentId === selectedClientId.value);
  return client ? getClientLabel(client) : "";
});

function getClientLabel(client: RegistryAgent): string {
  return CLIENT_LABELS[client.clientInfo?.clientName ?? ""] ?? client.clientInfo?.clientName ?? "AI Client";
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

function onSelectClient(client: RegistryAgent): void {
  if (selectedClientId.value === client.agentId) {
    chatStore.selectClient(null);
  } else {
    chatStore.selectClient(client);
  }
}
</script>

<style scoped>
.project-group {
  border-radius: 16px;
  border: 1px solid rgba(196, 161, 255, 0.18);
  background: linear-gradient(160deg, rgba(30, 23, 20, 0.95), rgba(24, 18, 15, 0.98));
  color: var(--text);
  overflow: hidden;
  transition: border-color 0.18s ease;
}

.project-group--selected {
  border-color: rgba(196, 161, 255, 0.42);
  box-shadow: 0 0 0 1px rgba(196, 161, 255, 0.12);
}

.project-group--degraded {
  border-color: rgba(255, 140, 124, 0.22);
}

.project-group__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px 12px;
  cursor: pointer;
  user-select: none;
}

.project-group__head:hover .group-name {
  color: var(--text);
}

.group-health-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}

.group-name {
  flex: 1;
  min-width: 0;
  font-size: 0.96rem;
  font-weight: 700;
  color: var(--text-mid);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.14s;
}

.group-type-badges {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.chip--nano {
  font-size: 0.62rem;
  min-height: 20px;
  padding: 0 7px;
  border-radius: 999px;
}

.group-count {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--text-dim);
  flex-shrink: 0;
}

.group-toggle {
  font-size: 0.85rem;
  color: var(--text-dim);
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.group-client-list {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
}

.group-client-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  text-align: left;
  cursor: pointer;
  transition: all 0.14s ease;
  width: 100%;
}

.group-client-row:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  border-color: rgba(255, 255, 255, 0.06);
}

.group-client-row--active {
  background: rgba(196, 161, 255, 0.1);
  border-color: rgba(196, 161, 255, 0.24);
  color: var(--text);
}

.client-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex-shrink: 0;
}

.client-label {
  flex: 1;
  min-width: 0;
  font-size: 0.84rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.client-version {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  color: var(--text-ghost);
  flex-shrink: 0;
}

.client-time {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  color: var(--text-ghost);
  flex-shrink: 0;
}

.group-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 16px 12px;
}

.group-path {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  color: var(--text-ghost);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.group-selected-hint {
  font-size: 0.7rem;
  color: var(--violet);
  flex-shrink: 0;
  white-space: nowrap;
}
</style>
