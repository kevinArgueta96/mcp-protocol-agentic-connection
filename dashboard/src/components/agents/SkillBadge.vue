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
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 700;
  border: 1px solid rgba(255, 236, 219, 0.12);
  color: var(--text-mid);
  background: rgba(255, 255, 255, 0.06);
  cursor: default;
  transition: border-color 0.12s, color 0.12s;
}
.skill-badge:hover {
  border-color: rgba(255, 236, 219, 0.24);
  color: var(--text);
}
.skill-active {
  border-color: rgba(116, 227, 156, 0.4);
  color: var(--emerald);
  background: rgba(116, 227, 156, 0.08);
}
</style>
