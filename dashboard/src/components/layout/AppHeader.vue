<template>
  <header class="app-header">
    <div class="app-brand">
      <div class="brand-mark">
        <div class="brand-mark-bars">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div class="brand-copy">
        <span class="brand-title">agent-bridge</span>
        <span class="brand-subtitle">live orchestration for agents, clients, traces and channels</span>
      </div>
    </div>

    <nav class="app-nav">
      <RouterLink
        v-for="tab in tabs"
        :key="tab.to"
        :to="tab.to"
        class="nav-tab"
        :class="$route.path === tab.to ? 'nav-tab--active' : ''"
      >
        {{ tab.label }}
        <span v-if="tab.to === '/channels' && pendingCount > 0" class="pending-badge">{{ pendingCount }}</span>
      </RouterLink>
    </nav>

    <div class="app-status">
      <div class="status-pill">
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
        <span class="status-label">{{ statusLabel }}</span>
      </div>
      <div class="stat-chip">
        <span class="stat-label">agents</span>
        <span class="stat-value">{{ healthyCount }}</span>
        <span class="status-label">/ {{ agentCount }}</span>
      </div>
      <div class="stat-chip">
        <span class="stat-label">clients</span>
        <span class="stat-value">{{ clientCount }}</span>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useRegistryStore } from "@/stores/registry";
import { fetchChannelConversations } from "@/lib/registry-client";

const $route = useRoute();
const store = useRegistryStore();

const rawStatus = computed(() => store.status);
const agentCount = computed(() => store.agentCount);
const healthyCount = computed(() => store.healthyCount);
const clientCount = computed(() => store.clientCount);

// Debounce "offline/error" by 2s to avoid flashing during brief WS reconnections
const status = ref(store.status);
let offlineTimer: ReturnType<typeof setTimeout> | null = null;

watch(rawStatus, (next) => {
  if (next === "connected" || next === "connecting") {
    if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
    status.value = next;
  } else {
    // disconnected or error — wait 2s before showing
    offlineTimer = setTimeout(() => {
      status.value = next;
      offlineTimer = null;
    }, 2000);
  }
});

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

const pendingCount = ref(0);

async function refreshPending() {
  try {
    const convs = await fetchChannelConversations({ pending: true });
    pendingCount.value = convs.filter((c: any) => !c.suppressed).length;
  } catch {}
}

let pendingInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void refreshPending();
  pendingInterval = setInterval(() => { void refreshPending(); }, 10_000);
});

onUnmounted(() => {
  if (pendingInterval !== null) clearInterval(pendingInterval);
});
</script>

<style scoped>
.pending-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  background: var(--red);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 0.6rem;
  border-radius: 999px;
  margin-left: 4px;
  font-weight: 700;
}
</style>
