<template>
  <div
    class="sig-card fade-in agent-card"
    :class="isClient ? 'card-client' : 'card-agent'"
    @click="expanded = !expanded"
  >
    <!-- Row 1: name + type badge -->
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-size:11px;font-weight:600;color:var(--text);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;">{{ displayName }}</span>
      <span class="chip" :class="isClient ? 'chip-violet' : typeChipClass" style="flex-shrink:0;">
        {{ isClient ? clientLabel : typeBadge }}
      </span>
    </div>

    <!-- Row 2: port / heartbeat + detail link -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;">
      <span style="font-size:10px;color:var(--text-dim);">
        <span v-if="!isClient" style="color:var(--text-dim);">:{{ agent.port }} · </span>{{ relativeTime }}
      </span>
      <RouterLink
        v-if="!isClient"
        :to="`/agents/${agent.agentId}`"
        class="detail-link"
        @click.stop
      >
        detail →
      </RouterLink>
    </div>

    <!-- Client: project path -->
    <div v-if="isClient" style="margin-top:4px;overflow:hidden;">
      <span style="font-size:10px;color:var(--text-dim);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{{ agent.projectPath }}</span>
    </div>

    <!-- Skills -->
    <div v-if="!isClient && agent.card.skills.length > 0" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;">
      <SkillBadge v-for="s in agent.card.skills.slice(0, 4)" :key="s.id" :skill="s" />
      <span v-if="agent.card.skills.length > 4" style="font-size:10px;color:var(--text-dim);align-self:center;">+{{ agent.card.skills.length - 4 }}</span>
    </div>

    <!-- Expanded JSON -->
    <div v-if="expanded" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-dim);">
      <PayloadViewer :data="agentJson" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { RouterLink } from "vue-router";
import { useTimeAgo } from "@vueuse/core";
import SkillBadge from "./SkillBadge.vue";
import PayloadViewer from "@/components/trace/PayloadViewer.vue";
import { projectTypeBadge } from "@/lib/utils";
import type { RegistryAgent } from "@/types";

const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude":      "Claude",
  "codex":       "Codex CLI",
  "gemini-cli":  "Gemini CLI",
  "cursor":      "Cursor",
  "copilot":     "Copilot",
};
const TYPE_CHIP: Record<string, string> = {
  node: "type-node", rust: "type-rust", go: "type-go",
  python: "type-python", java: "type-java", unknown: "type-unknown",
};

const props = defineProps<{ agent: RegistryAgent }>();
const expanded = ref(false);
const isClient = computed(() => props.agent.entryType === "client");
const clientLabel = computed(() => CLIENT_LABELS[props.agent.clientInfo?.clientName ?? ""] ?? props.agent.clientInfo?.clientName ?? "AI Client");
const displayName = computed(() => isClient.value ? clientLabel.value : props.agent.projectName);
const relativeTime = useTimeAgo(computed(() => new Date(props.agent.lastHeartbeat)));
const typeBadge = computed(() => projectTypeBadge(props.agent.projectType));
const typeChipClass = computed(() => TYPE_CHIP[props.agent.projectType] ?? "type-unknown");

const agentJson = computed(() => ({
  agentId: props.agent.agentId,
  name: props.agent.name,
  url: props.agent.url,
  projectPath: props.agent.projectPath,
  projectType: props.agent.projectType,
  healthy: props.agent.healthy,
  registeredAt: new Date(props.agent.registeredAt).toISOString(),
  lastHeartbeat: new Date(props.agent.lastHeartbeat).toISOString(),
  ...(isClient.value
    ? { clientInfo: props.agent.clientInfo }
    : { skills: props.agent.card.skills.map((s) => s.id) }),
}));
</script>

<style scoped>
.agent-card {
  padding: 10px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background-color 0.15s, border-color 0.15s;
}
.agent-card:hover {
  background-color: color-mix(in srgb, var(--text) 4%, transparent);
}
.card-agent {
  border-color: color-mix(in srgb, var(--emerald) 25%, var(--border-dim));
  border-left-color: var(--emerald);
}
.card-client {
  border-color: color-mix(in srgb, var(--indigo) 25%, var(--border-dim));
  border-left-color: var(--indigo);
}
.detail-link {
  font-size: 10px;
  color: var(--text-dim);
  text-decoration: none;
  transition: color 0.15s;
}
.detail-link:hover { color: var(--sky); }
</style>
