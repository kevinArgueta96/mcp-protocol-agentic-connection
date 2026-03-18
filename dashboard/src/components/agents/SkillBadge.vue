<template>
  <span class="skill-badge" :class="active ? 'skill-active' : ''" :title="skill.description">
    {{ skill.id }}
  </span>
</template>

<script setup lang="ts">
import type { AgentSkill } from "@/types";
defineProps<{ skill: AgentSkill; active?: boolean }>();
</script>

<style scoped>
.skill-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 2px;
  font-size: 9px;
  font-weight: 500;
  border: 1px solid var(--border-mid);
  color: var(--text-dim);
  background: var(--surface-2);
  cursor: default;
  transition: border-color 0.12s, color 0.12s;
}
.skill-badge:hover {
  border-color: var(--border-lit);
  color: var(--text-mid);
}
.skill-active {
  border-color: color-mix(in srgb, var(--emerald) 40%, transparent);
  color: var(--emerald);
  background: color-mix(in srgb, var(--emerald) 8%, transparent);
}
</style>
