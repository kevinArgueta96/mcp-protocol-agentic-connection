<template>
  <div class="panel">
    <div class="panel-header">
      <div class="panel-heading">
        <span class="panel-label">Trace</span>
        <span class="panel-sublabel">task state changes, channel traffic and tool activity in a single live timeline</span>
      </div>
      <button v-if="events.length > 0" class="btn-ghost" @click="store.clearEvents()">
        clear
      </button>
    </div>

    <TraceFilters />

    <div v-if="filteredEvents.length === 0" class="empty-state">
      <div class="empty-state__icon">◎</div>
      <p class="empty-state__title">No events yet</p>
      <p class="empty-state__body">Once an agent connects, a task runs or a channel message moves through the bridge, the timeline will start filling in.</p>
    </div>

    <div v-else ref="scrollEl" class="scrollable trace-list">
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
