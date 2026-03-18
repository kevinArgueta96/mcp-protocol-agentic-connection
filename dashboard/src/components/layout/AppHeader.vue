<template>
  <header class="flex items-center justify-between px-4 h-10 border-b border-white/5 bg-[#0a0e14] shrink-0">
    <!-- Left: brand -->
    <div class="flex items-center gap-3">
      <span class="font-mono text-xs font-semibold text-emerald-400 tracking-wider uppercase">
        agent-bridge
      </span>
      <span class="text-white/20 text-xs">|</span>
      <span class="text-white/40 text-xs">mission control</span>
    </div>

    <!-- Center: nav tabs -->
    <nav class="flex items-center gap-1">
      <RouterLink
        v-for="tab in tabs"
        :key="tab.to"
        :to="tab.to"
        class="px-3 py-1 rounded text-xs font-mono transition-colors"
        :class="[$route.path === tab.to ? 'bg-white/8 text-white' : 'text-white/40 hover:text-white/70']"
      >
        {{ tab.label }}
      </RouterLink>
    </nav>

    <!-- Right: status indicators -->
    <div class="flex items-center gap-4">
      <!-- WS status -->
      <div class="flex items-center gap-1.5">
        <span
          class="w-1.5 h-1.5 rounded-full"
          :class="{
            'bg-emerald-400 pulse-healthy': status === 'connected',
            'bg-amber-400 pulse-working': status === 'connecting',
            'bg-red-400': status === 'disconnected' || status === 'error',
          }"
        />
        <span class="font-mono text-xs text-white/40">{{ statusLabel }}</span>
      </div>

      <!-- Agent count -->
      <div class="flex items-center gap-1.5 font-mono text-xs">
        <span class="text-white/40">agents</span>
        <span class="text-emerald-400 font-semibold">{{ healthyCount }}</span>
        <span class="text-white/20">/</span>
        <span class="text-white/60">{{ agentCount }}</span>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useRegistryStore } from "@/stores/registry";

const $route = useRoute();
const store = useRegistryStore();

const status = computed(() => store.status);
const agentCount = computed(() => store.agentCount);
const healthyCount = computed(() => store.healthyCount);

const statusLabel = computed(() => {
  const map: Record<string, string> = {
    connected: "live",
    connecting: "connecting...",
    disconnected: "offline",
    error: "error",
  };
  return map[status.value] ?? status.value;
});

const tabs = [
  { to: "/", label: "dashboard" },
];
</script>
