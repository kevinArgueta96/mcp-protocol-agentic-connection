<template>
  <header style="display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:40px;background:var(--surface-0);border-bottom:1px solid var(--border-dim);flex-shrink:0;">

    <!-- Brand -->
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="display:flex;align-items:center;gap:2px;">
        <span style="width:3px;height:10px;border-radius:1px;background:var(--sky);opacity:0.5;display:block;" />
        <span style="width:3px;height:14px;border-radius:1px;background:var(--sky);opacity:0.8;display:block;" />
        <span style="width:3px;height:10px;border-radius:1px;background:var(--sky);opacity:0.5;display:block;" />
      </div>
      <span style="font-size:13px;font-weight:700;color:var(--text);letter-spacing:0.02em;">agent-bridge</span>
      <span style="font-size:10px;color:var(--text-dim);">/ mission control</span>
    </div>

    <!-- Nav -->
    <nav style="display:flex;align-items:center;gap:4px;">
      <RouterLink
        v-for="tab in tabs"
        :key="tab.to"
        :to="tab.to"
        class="nav-tab"
        :class="$route.path === tab.to ? 'nav-tab--active' : ''"
      >
        {{ tab.label }}
      </RouterLink>
    </nav>

    <!-- Status -->
    <div style="display:flex;align-items:center;gap:16px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <span
          class="health-dot"
          :class="{
            'pulse-healthy': status === 'connected',
            'pulse-working': status === 'connecting',
            'pulse-error':   status === 'disconnected' || status === 'error',
          }"
          :style="{
            background: status === 'connected' ? 'var(--emerald)' :
                        status === 'connecting' ? 'var(--amber)' : 'var(--red)'
          }"
        />
        <span style="font-size:10px;color:var(--text-dim);">{{ statusLabel }}</span>
      </div>
      <div style="display:flex;align-items:center;gap:4px;font-size:10px;">
        <span style="color:var(--text-dim);">agents</span>
        <span style="color:var(--emerald);font-weight:700;">{{ healthyCount }}</span>
        <span style="color:var(--text-ghost);">/</span>
        <span style="color:var(--text-mid);">{{ agentCount }}</span>
      </div>
      <div style="display:flex;align-items:center;gap:4px;font-size:10px;">
        <span style="color:var(--text-dim);">clients</span>
        <span style="color:var(--indigo);font-weight:700;">{{ clientCount }}</span>
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
const clientCount = computed(() => store.clientCount);

const statusLabel = computed(() => ({
  connected: "live",
  connecting: "connecting…",
  disconnected: "offline",
  error: "error",
}[status.value] ?? status.value));

const tabs = [
  { to: "/", label: "dashboard" },
  { to: "/channels", label: "channels" },
];
</script>

<style scoped>
.nav-tab {
  padding: 3px 10px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 500;
  color: var(--text-dim);
  text-decoration: none;
  transition: color 0.15s, background 0.15s;
  border: 1px solid transparent;
}
.nav-tab:hover { color: var(--text-mid); }
.nav-tab--active {
  color: var(--text);
  background: var(--surface-2);
  border-color: var(--border-mid);
}
</style>
