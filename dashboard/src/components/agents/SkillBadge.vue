<template>
  <span
    class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border cursor-default transition-colors"
    :class="active ? 'border-emerald-500/50 text-emerald-400 bg-emerald-500/10' : 'border-white/10 text-white/40 hover:text-white/70 hover:border-white/20'"
    :title="skill.description"
  >
    {{ skill.id }}
  </span>
</template>

<script setup lang="ts">
import type { AgentSkill } from "@/types";

defineProps<{
  skill: AgentSkill;
  active?: boolean;
}>();
</script>
