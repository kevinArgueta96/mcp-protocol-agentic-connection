<template>
  <div
    class="border-l-2 pl-3 py-2 pr-2 cursor-pointer hover:bg-white/2 transition-colors rounded-r"
    :class="borderClass"
    @click="store.toggleExpanded(event.id)"
  >
    <!-- Top row -->
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <!-- State badge -->
        <span
          class="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold border"
          :class="stateClass"
        >
          {{ event.state }}
        </span>
        <!-- Agent name -->
        <span class="font-mono text-[10px] text-white/60 truncate">{{ event.agentName }}</span>
        <!-- Skill badge -->
        <span
          v-if="event.skillId"
          class="shrink-0 text-[9px] font-mono text-white/30 border border-white/10 px-1 rounded"
        >
          {{ event.skillId }}
        </span>
      </div>
      <!-- Timestamp -->
      <span class="font-mono text-[9px] text-white/25 shrink-0">{{ formattedTime }}</span>
    </div>

    <!-- Task ID -->
    <div class="mt-0.5">
      <span class="font-mono text-[9px] text-white/25">{{ shortTaskId }}</span>
    </div>

    <!-- Expanded payload -->
    <div v-if="event.expanded && event.payload" class="mt-2 pt-2 border-t border-white/5">
      <PayloadViewer :data="event.payload" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useTraceStore } from "@/stores/trace";
import PayloadViewer from "./PayloadViewer.vue";
import { formatTimestamp, STATE_COLORS } from "@/lib/utils";
import type { TraceEvent } from "@/types";

const props = defineProps<{ event: TraceEvent }>();
const store = useTraceStore();

const formattedTime = computed(() => formatTimestamp(props.event.timestamp));
const shortTaskId = computed(() => props.event.taskId.slice(0, 8) + "...");

const borderClass = computed(() => {
  const map: Record<string, string> = {
    submitted: "border-blue-500",
    working: "border-amber-500",
    completed: "border-emerald-500",
    failed: "border-red-500",
    canceled: "border-zinc-500",
  };
  return map[props.event.state] ?? "border-white/20";
});

const stateClass = computed(() => STATE_COLORS[props.event.state] ?? "text-white/40 border-white/20");
</script>
