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
        <!-- Skill / step / tool badge -->
        <span
          v-if="badgeLabel"
          class="shrink-0 text-[9px] font-mono px-1 rounded border"
          :class="badgeClass"
        >
          {{ badgeLabel }}
        </span>
        <!-- Kind indicator -->
        <span
          v-if="event.kind && event.kind !== 'task'"
          class="shrink-0 text-[8px] font-mono px-1 rounded"
          :class="event.kind === 'ag-ui-tool' ? 'bg-violet-500/15 text-violet-400' : 'bg-cyan-500/15 text-cyan-400'"
        >
          {{ event.kind === "ag-ui-tool" ? "tool" : "step" }}
        </span>
      </div>
      <!-- Timestamp -->
      <span class="font-mono text-[9px] text-white/25 shrink-0">{{ formattedTime }}</span>
    </div>

    <!-- Task / thread ID -->
    <div class="mt-0.5">
      <span class="font-mono text-[9px] text-white/25">{{ shortTaskId }}</span>
    </div>

    <!-- Tool call args (ag-ui-tool) -->
    <div v-if="event.kind === 'ag-ui-tool' && event.toolCallArgs" class="mt-1">
      <pre class="font-mono text-[9px] text-white/30 whitespace-pre-wrap break-all bg-white/2 rounded px-1.5 py-1">{{ argsPreview }}</pre>
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
  if (props.event.kind === "ag-ui-tool") return "border-violet-500";
  if (props.event.kind === "ag-ui-step") return "border-cyan-500";
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

const badgeLabel = computed(() => {
  if (props.event.kind === "ag-ui-tool") return props.event.toolCallName;
  if (props.event.kind === "ag-ui-step") return props.event.stepName;
  return props.event.skillId;
});

const badgeClass = computed(() => {
  if (props.event.kind === "ag-ui-tool") return "text-violet-300 border-violet-500/30";
  if (props.event.kind === "ag-ui-step") return "text-cyan-300 border-cyan-500/30";
  return "text-white/30 border-white/10";
});

const argsPreview = computed(() => {
  const args = props.event.toolCallArgs;
  if (!args) return "";
  const str = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  return str.length > 200 ? str.slice(0, 200) + "…" : str;
});
</script>
