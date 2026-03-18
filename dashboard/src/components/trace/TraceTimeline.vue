<template>
  <div class="flex flex-col h-full min-h-0">
    <TraceFilters />

    <!-- Empty state -->
    <div
      v-if="filteredEvents.length === 0"
      class="flex flex-col items-center justify-center h-full text-center px-6"
    >
      <p class="text-white/30 text-xs font-mono">No task events yet</p>
      <p class="text-white/20 text-[10px] mt-1 font-mono">
        Send a task via CLI or the chat panel
      </p>
    </div>

    <!-- Events list -->
    <div
      v-else
      ref="scrollEl"
      class="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5"
    >
      <TraceEntry
        v-for="event in filteredEvents"
        :key="event.id"
        :event="event"
      />
    </div>

    <!-- Footer: clear button -->
    <div class="flex items-center justify-between px-3 py-1.5 border-t border-white/5 shrink-0">
      <span class="font-mono text-[9px] text-white/20">task lifecycle trace</span>
      <button
        v-if="events.length > 0"
        class="text-[9px] font-mono text-white/20 hover:text-white/50 transition-colors"
        @click="store.clearEvents()"
      >
        clear all
      </button>
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

// Auto-scroll to top on new events (newest first)
watch(
  () => store.events.length,
  async () => {
    await nextTick();
    if (scrollEl.value) scrollEl.value.scrollTop = 0;
  }
);
</script>
