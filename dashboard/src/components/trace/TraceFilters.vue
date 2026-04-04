<template>
  <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--border-dim);flex-shrink:0;flex-wrap:wrap;background:color-mix(in srgb,var(--surface-1) 50%,transparent);">

    <!-- Agent filter -->
    <div style="display:flex;align-items:center;gap:4px;">
      <label style="font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-ghost);flex-shrink:0;">agent</label>
      <div style="position:relative;display:inline-flex;align-items:center;">
        <select
          class="sig-select"
          style="padding:3px 18px 3px 7px;height:24px;"
          :value="filters.agentId ?? ''"
          @change="(e) => store.setFilter('agentId', (e.target as HTMLSelectElement).value)"
        >
          <option value="">all</option>
          <option v-for="a in agentList" :key="a.agentId" :value="a.agentId">{{ a.projectName }}</option>
        </select>
        <span style="position:absolute;right:4px;pointer-events:none;font-size:8px;color:var(--text-ghost);">▾</span>
      </div>
    </div>

    <!-- State filter -->
    <div style="display:flex;align-items:center;gap:4px;">
      <label style="font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-ghost);flex-shrink:0;">state</label>
      <div style="position:relative;display:inline-flex;align-items:center;">
        <select
          class="sig-select"
          style="padding:3px 18px 3px 7px;height:24px;"
          :value="filters.state ?? ''"
          @change="(e) => store.setFilter('state', (e.target as HTMLSelectElement).value as TaskState)"
        >
          <option value="">all</option>
          <option v-for="s in states" :key="s" :value="s">{{ s }}</option>
        </select>
        <span style="position:absolute;right:4px;pointer-events:none;font-size:8px;color:var(--text-ghost);">▾</span>
      </div>
    </div>

    <!-- Client filter -->
    <div v-if="clientList.length > 0" style="display:flex;align-items:center;gap:4px;">
      <label style="font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-ghost);flex-shrink:0;">client</label>
      <div style="position:relative;display:inline-flex;align-items:center;">
        <select
          class="sig-select"
          style="padding:3px 18px 3px 7px;height:24px;"
          :value="filters.clientId ?? ''"
          @change="(e) => store.setFilter('clientId', (e.target as HTMLSelectElement).value)"
        >
          <option value="">all</option>
          <option v-for="c in clientList" :key="c.agentId" :value="c.agentId">{{ c.clientInfo?.clientName ?? c.name }}</option>
        </select>
        <span style="position:absolute;right:4px;pointer-events:none;font-size:8px;color:var(--text-ghost);">▾</span>
      </div>
    </div>

    <!-- Kind filter -->
    <div style="display:flex;align-items:center;gap:4px;">
      <label style="font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-ghost);flex-shrink:0;">kind</label>
      <div style="position:relative;display:inline-flex;align-items:center;">
        <select
          class="sig-select"
          style="padding:3px 18px 3px 7px;height:24px;"
          :value="filters.kind ?? ''"
          @change="(e) => store.setFilter('kind', (e.target as HTMLSelectElement).value)"
        >
          <option value="">all</option>
          <option v-for="k in kinds" :key="k" :value="k">{{ k }}</option>
        </select>
        <span style="position:absolute;right:4px;pointer-events:none;font-size:8px;color:var(--text-ghost);">▾</span>
      </div>
    </div>

    <!-- Clear + count -->
    <div style="display:flex;align-items:center;gap:8px;margin-left:auto;">
      <button v-if="hasFilters" class="btn-ghost" style="padding:2px 6px;font-size:9px;" @click="store.clearFilters()">
        ✕ clear
      </button>
      <span style="font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;">
        <span :style="{ color: hasFilters ? 'var(--sky)' : 'var(--text-dim)' }">{{ filteredCount }}</span>
        <span style="color:var(--text-ghost);">/{{ totalCount }}</span>
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
