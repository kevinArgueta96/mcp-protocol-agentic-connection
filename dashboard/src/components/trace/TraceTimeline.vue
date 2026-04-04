<template>
  <div class="panel" style="--panel-color: var(--sky);">

    <div class="panel-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="panel-label">Trace</span>
        <span class="panel-sublabel">tasks + channels</span>
      </div>
      <button v-if="events.length > 0" class="btn-ghost" style="font-size:9px;padding:1px 6px;" @click="store.clearEvents()">
        clear
      </button>
    </div>

    <TraceFilters />

    <!-- Empty -->
    <div v-if="filteredEvents.length === 0" style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:8px;text-align:center;padding:24px;">
      <span style="font-size:20px;opacity:0.12;">◎</span>
      <p style="font-size:11px;color:var(--text-mid);font-weight:600;margin:0;">No events yet</p>
      <p style="font-size:10px;color:var(--text-ghost);margin:0;">Connect a client or send a task/channel message</p>
    </div>

    <!-- Events -->
    <div v-else ref="scrollEl" class="scrollable" style="padding:8px;display:flex;flex-direction:column;gap:3px;">
      <TraceEntry v-for="event in filteredEvents" :key="event.id" :event="event" />
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useTraceStore } from "@/stores/trace";
import TraceFilters from "./TraceFilters.vue";
import TraceEntry from "./TraceEntry.vue";

const store = useTraceStore();
const scrollEl = ref<HTMLElement | null>(null);
const events = computed(() => store.events);
const filteredEvents = computed(() => store.filteredEvents);

watch(() => store.events.length, async () => {
  await nextTick();
  if (scrollEl.value) scrollEl.value.scrollTop = 0;
});
</script>
