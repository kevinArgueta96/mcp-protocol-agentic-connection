<template>
  <div
    class="card p-3 cursor-pointer hover:border-white/10 transition-all fade-in"
    :class="{ 'border-emerald-500/20': agent.healthy, 'border-red-500/20': !agent.healthy }"
    @click="expanded = !expanded"
  >
    <!-- Header row -->
    <div class="flex items-start justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <HealthPulse :healthy="agent.healthy" />
        <span class="font-mono text-xs font-semibold text-white truncate">{{ agent.projectName }}</span>
        <span
          class="shrink-0 px-1 py-0.5 rounded text-[9px] font-mono font-semibold border"
          :class="typeClass"
        >
          {{ typeBadge }}
        </span>
      </div>
      <span class="font-mono text-[10px] text-white/30 shrink-0">:{{ agent.port }}</span>
    </div>

    <!-- Heartbeat -->
    <div class="mt-1.5 flex items-center justify-between">
      <span class="text-[10px] text-white/30 font-mono">
        {{ relativeTime }}
      </span>
      <RouterLink
        :to="`/agents/${agent.agentId}`"
        class="text-[10px] text-white/30 hover:text-blue-400 transition-colors font-mono"
        @click.stop
      >
        detail →
      </RouterLink>
    </div>

    <!-- Skills row -->
    <div v-if="agent.card.skills.length > 0" class="mt-2 flex flex-wrap gap-1">
      <SkillBadge
        v-for="skill in agent.card.skills.slice(0, 4)"
        :key="skill.id"
        :skill="skill"
      />
      <span
        v-if="agent.card.skills.length > 4"
        class="text-[10px] text-white/30 font-mono self-center"
      >
        +{{ agent.card.skills.length - 4 }}
      </span>
    </div>

    <!-- Expanded: full agent JSON -->
    <div v-if="expanded" class="mt-3 pt-3 border-t border-white/5">
      <PayloadViewer :data="agentJson" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { RouterLink } from "vue-router";
import { useTimeAgo } from "@vueuse/core";
import HealthPulse from "./HealthPulse.vue";
import SkillBadge from "./SkillBadge.vue";
import PayloadViewer from "@/components/trace/PayloadViewer.vue";
import { projectTypeBadge } from "@/lib/utils";
import type { RegistryAgent } from "@/types";

const props = defineProps<{ agent: RegistryAgent }>();
const expanded = ref(false);

const relativeTime = useTimeAgo(computed(() => new Date(props.agent.lastHeartbeat)));

const typeBadge = computed(() => projectTypeBadge(props.agent.projectType));

const typeClass = computed(() => {
  const map: Record<string, string> = {
    node: "border-yellow-500/40 text-yellow-400",
    rust: "border-orange-500/40 text-orange-400",
    go: "border-cyan-500/40 text-cyan-400",
    python: "border-blue-500/40 text-blue-400",
    java: "border-red-500/40 text-red-400",
    unknown: "border-white/20 text-white/40",
  };
  return map[props.agent.projectType] ?? map.unknown;
});

const agentJson = computed(() => ({
  agentId: props.agent.agentId,
  name: props.agent.name,
  url: props.agent.url,
  wsUrl: props.agent.wsUrl,
  projectPath: props.agent.projectPath,
  projectType: props.agent.projectType,
  healthy: props.agent.healthy,
  registeredAt: new Date(props.agent.registeredAt).toISOString(),
  lastHeartbeat: new Date(props.agent.lastHeartbeat).toISOString(),
  skills: props.agent.card.skills.map((s) => s.id),
}));
</script>
