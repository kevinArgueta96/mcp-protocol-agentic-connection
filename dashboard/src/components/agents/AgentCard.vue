<template>
  <div
    class="sig-card fade-in agent-card"
    :class="[isClient ? 'card-client' : 'card-agent', { 'card--unhealthy': !agent.healthy }]"
    :style="{ '--card-accent': isClient ? 'var(--violet)' : 'var(--emerald)' }"
    @click="expanded = !expanded"
  >
    <div class="agent-card__header">
      <HealthPulse :healthy="agent.healthy ?? false" />
      <span :title="agent.projectPath" class="agent-card__name">{{ displayName }}</span>
      <span
        class="chip"
        :class="isClient ? 'chip-violet' : typeChipClass"
        :title="isClient ? chipTooltip : undefined"
      >
        {{ isClient ? clientLabel : typeBadge }}
      </span>
    </div>

    <div class="agent-card__meta">
      <span>
        <span v-if="!isClient">:{{ agent.port }} · </span>{{ relativeTime }}
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

    <div v-if="isClient" class="agent-card__path">
      {{ agent.projectPath }}
    </div>

    <div v-if="!isClient && agent.card.skills.length > 0" class="agent-card__skills">
      <SkillBadge v-for="s in agent.card.skills.slice(0, 4)" :key="s.id" :skill="s" />
      <span v-if="agent.card.skills.length > 4" class="chip chip-dim">+{{ agent.card.skills.length - 4 }}</span>
    </div>

    <div v-if="expanded" style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);">
      <PayloadViewer :data="agentJson" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { RouterLink } from "vue-router";
import { useTimeAgo } from "@vueuse/core";
import SkillBadge from "./SkillBadge.vue";
import HealthPulse from "./HealthPulse.vue";
import PayloadViewer from "@/components/trace/PayloadViewer.vue";
import { projectTypeBadge } from "@/lib/utils";
import type { RegistryAgent } from "@/types";

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
const TYPE_CHIP: Record<string, string> = {
  node: "type-node", rust: "type-rust", go: "type-go",
  python: "type-python", java: "type-java", unknown: "type-unknown",
};

const props = defineProps<{ agent: RegistryAgent }>();
const expanded = ref(false);
const isClient = computed(() => props.agent.entryType === "client");
const clientLabel = computed(() => CLIENT_LABELS[props.agent.clientInfo?.clientName ?? ""] ?? props.agent.clientInfo?.clientName ?? "AI Client");
const chipTooltip = computed(() => {
  const info = props.agent.clientInfo;
  if (!info) return undefined;
  const label = CLIENT_LABELS[info.clientName] ?? info.clientName;
  return `${label} v${info.clientVersion}`;
});
const displayName = computed(() => props.agent.projectName || (isClient.value ? clientLabel.value : props.agent.name));
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
  cursor: pointer;
  transition: transform 0.18s ease, border-color 0.18s ease;
}
.agent-card:hover {
  transform: translateY(-1px);
}
.card-agent {
  border-color: rgba(116, 227, 156, 0.16);
}
.card-client {
  border-color: rgba(196, 161, 255, 0.16);
}
.card--unhealthy {
  opacity: 0.65;
  border-color: rgba(255, 140, 124, 0.3);
}
</style>
