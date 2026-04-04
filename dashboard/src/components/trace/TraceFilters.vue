<template>
  <div class="toolbar">
    <div class="toolbar-field">
      <label class="toolbar-label">Agent</label>
      <div class="select-wrap">
        <select
          class="sig-select"
          :value="filters.agentId ?? ''"
          @change="(e) => store.setFilter('agentId', (e.target as HTMLSelectElement).value)"
        >
          <option value="">all</option>
          <option v-for="a in agentList" :key="a.agentId" :value="a.agentId">{{ a.projectName }}</option>
        </select>
        <span class="select-caret">▾</span>
      </div>
    </div>

    <div class="toolbar-field">
      <label class="toolbar-label">State</label>
      <div class="select-wrap">
        <select
          class="sig-select"
          :value="filters.state ?? ''"
          @change="(e) => store.setFilter('state', (e.target as HTMLSelectElement).value as TaskState)"
        >
          <option value="">all</option>
          <option v-for="s in states" :key="s" :value="s">{{ s }}</option>
        </select>
        <span class="select-caret">▾</span>
      </div>
    </div>

    <div v-if="clientList.length > 0" class="toolbar-field">
      <label class="toolbar-label">Client</label>
      <div class="select-wrap">
        <select
          class="sig-select"
          :value="filters.clientId ?? ''"
          @change="(e) => store.setFilter('clientId', (e.target as HTMLSelectElement).value)"
        >
          <option value="">all</option>
          <option v-for="c in clientList" :key="c.agentId" :value="c.agentId">{{ c.clientInfo?.clientName ?? c.name }}</option>
        </select>
        <span class="select-caret">▾</span>
      </div>
    </div>

    <div class="toolbar-field">
      <label class="toolbar-label">Kind</label>
      <div class="select-wrap">
        <select
          class="sig-select"
          :value="filters.kind ?? ''"
          @change="(e) => store.setFilter('kind', (e.target as HTMLSelectElement).value)"
        >
          <option value="">all</option>
          <option v-for="k in kinds" :key="k" :value="k">{{ k }}</option>
        </select>
        <span class="select-caret">▾</span>
      </div>
    </div>

    <div class="toolbar-count">
      <button v-if="hasFilters" class="btn-ghost" @click="store.clearFilters()">
        clear filters
      </button>
      <span>
        <span :class="hasFilters ? 'trace-count-active' : 'trace-count-idle'">{{ filteredCount }}</span>
        <span class="trace-count-total"> / {{ totalCount }}</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useTraceStore } from "@/stores/trace";
import { useRegistryStore } from "@/stores/registry";
import type { TaskState, TraceEventKind } from "@/types";

const store = useTraceStore();
const registryStore = useRegistryStore();

const filters = computed(() => store.filters);
const agentList = computed(() => registryStore.agentList.filter((a) => a.entryType !== "client"));
const clientList = computed(() => registryStore.agentList.filter((a) => a.entryType === "client"));
const hasFilters = computed(() => !!(filters.value.agentId || filters.value.state || filters.value.skillId || filters.value.clientId || filters.value.kind));
const filteredCount = computed(() => store.filteredEvents.length);
const totalCount = computed(() => store.events.length);

const states: TaskState[] = ["submitted", "working", "input-required", "completed", "failed", "canceled"];
const kinds: TraceEventKind[] = ["task", "channel-message", "channel-ack", "ag-ui-step", "ag-ui-tool"];
</script>

<style scoped>
.trace-count-active {
  color: var(--text-ink);
}

.trace-count-idle {
  color: rgba(39, 29, 25, 0.58);
}

.trace-count-total {
  color: rgba(39, 29, 25, 0.36);
}
</style>
