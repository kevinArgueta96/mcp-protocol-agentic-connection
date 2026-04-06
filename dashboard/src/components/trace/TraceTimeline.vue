<template>
  <div class="panel">
    <div class="panel-header">
      <div class="panel-heading">
        <span class="panel-label">Trace</span>
        <span class="panel-sublabel">task state changes, channel traffic and tool activity in a single live timeline</span>
      </div>
      <div class="trace-header-actions">
        <div class="group-toggle">
          <button
            class="group-pill"
            :class="{ 'group-pill--active': groupMode === 'flat' }"
            @click="groupMode = 'flat'"
          >flat</button>
          <button
            class="group-pill"
            :class="{ 'group-pill--active': groupMode === 'grouped' }"
            @click="groupMode = 'grouped'"
          >grouped</button>
        </div>
        <button v-if="events.length > 0" class="btn-ghost" @click="store.clearEvents()">
          clear
        </button>
      </div>
    </div>

    <TraceFilters />

    <div v-if="filteredEvents.length === 0" class="empty-state">
      <div class="empty-state__icon">◎</div>
      <p class="empty-state__title">No events yet</p>
      <p class="empty-state__body">Once an agent connects, a task runs or a channel message moves through the bridge, the timeline will start filling in.</p>
    </div>

    <div v-else-if="groupMode === 'flat'" ref="scrollEl" class="scrollable trace-list">
      <TraceEntry v-for="event in filteredEvents" :key="event.id" :event="event" />
    </div>

    <div v-else ref="scrollEl" class="scrollable trace-list">
      <template v-for="group in groupedEvents" :key="group.conversationId">
        <div class="trace-group-header">
          {{ group.conversationId.slice(0, 8) }} · {{ group.events.length }} event{{ group.events.length !== 1 ? 's' : '' }}
        </div>
        <TraceEntry v-for="event in group.events" :key="event.id" :event="event" />
      </template>
      <template v-if="ungroupedEvents.length > 0">
        <div class="trace-group-header">
          no conversation · {{ ungroupedEvents.length }} event{{ ungroupedEvents.length !== 1 ? 's' : '' }}
        </div>
        <TraceEntry v-for="event in ungroupedEvents" :key="event.id" :event="event" />
      </template>
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
const groupMode = ref<'flat' | 'grouped'>('flat');

const groupedEvents = computed(() => {
  const withConv = filteredEvents.value.filter((e) => e.conversationId);
  const map = new Map<string, typeof withConv>();
  for (const event of withConv) {
    const key = event.conversationId!;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(event);
  }
  return Array.from(map.entries()).map(([conversationId, evts]) => ({
    conversationId,
    events: evts,
  }));
});

const ungroupedEvents = computed(() =>
  filteredEvents.value.filter((e) => !e.conversationId)
);

watch(() => store.events.length, async () => {
  await nextTick();
  if (scrollEl.value) scrollEl.value.scrollTop = 0;
});
</script>

<style scoped>
.trace-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.group-toggle {
  display: flex;
  border: 1px solid rgba(221, 186, 154, 0.2);
  border-radius: 6px;
  overflow: hidden;
}

.group-pill {
  padding: 3px 10px;
  font-family: var(--font-mono);
  font-size: 0.65rem;
  color: var(--text-dim);
  background: transparent;
  border: none;
  cursor: pointer;
  letter-spacing: 0.04em;
  transition: background 0.2s ease, color 0.2s ease;
}

.group-pill:hover {
  background: rgba(221, 186, 154, 0.08);
  color: var(--text);
}

.group-pill--active {
  background: rgba(221, 186, 154, 0.14);
  color: var(--text);
}

.trace-group-header {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  color: var(--text-dim);
  padding: 6px 14px 4px;
  background: rgba(32, 24, 20, 0.85);
  position: sticky;
  top: 0;
  z-index: 2;
  letter-spacing: 0.06em;
  border-bottom: 1px solid rgba(221, 186, 154, 0.08);
}
</style>
