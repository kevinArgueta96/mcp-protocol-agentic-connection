<template>
  <div class="flex items-center gap-2 px-3 py-2 border-b border-white/5 shrink-0">
    <span class="font-mono text-[10px] text-white/40 uppercase tracking-wider shrink-0">Filter</span>

    <!-- Agent filter -->
    <select
      class="flex-1 bg-white/5 border border-white/10 rounded px-2 py-0.5 text-[10px] font-mono text-white/60 focus:outline-none focus:border-white/20"
      :value="filters.agentId ?? ''"
      @change="(e) => store.setFilter('agentId', (e.target as HTMLSelectElement).value)"
    >
      <option value="">all agents</option>
      <option v-for="agent in agentList" :key="agent.agentId" :value="agent.agentId">
        {{ agent.projectName }}
      </option>
    </select>

    <!-- State filter -->
    <select
      class="flex-1 bg-white/5 border border-white/10 rounded px-2 py-0.5 text-[10px] font-mono text-white/60 focus:outline-none focus:border-white/20"
      :value="filters.state ?? ''"
      @change="(e) => store.setFilter('state', (e.target as HTMLSelectElement).value as TaskState)"
    >
      <option value="">all states</option>
      <option v-for="s in states" :key="s" :value="s">{{ s }}</option>
    </select>

    <!-- Clear -->
    <button
      v-if="hasFilters"
      class="text-[10px] font-mono text-white/30 hover:text-white/60 transition-colors shrink-0"
      @click="store.clearFilters()"
    >
      clear
    </button>

    <!-- Event count -->
    <span class="font-mono text-[10px] text-white/30 shrink-0 ml-auto">
      {{ filteredCount }}/{{ totalCount }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useTraceStore } from "@/stores/trace";
import { useRegistryStore } from "@/stores/registry";
import type { TaskState } from "@/types";

const store = useTraceStore();
const registryStore = useRegistryStore();

const filters = computed(() => store.filters);
const agentList = computed(() => registryStore.agentList);
const hasFilters = computed(() => !!(filters.value.agentId || filters.value.state || filters.value.skillId));
const filteredCount = computed(() => store.filteredEvents.length);
const totalCount = computed(() => store.events.length);

const states: TaskState[] = ["submitted", "working", "completed", "failed", "canceled"];
</script>
