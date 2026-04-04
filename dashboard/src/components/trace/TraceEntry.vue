<template>
  <div class="trace-entry fade-in" :class="borderClass" @click="store.toggleExpanded(event.id)">

    <!-- Row 1: state + agent + badges + time -->
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <span class="state-badge" :class="`state-${event.state}`">{{ event.state }}</span>
      <span style="font-size:10px;font-weight:600;color:var(--text);">{{ event.agentName }}</span>

      <span v-if="badgeLabel" class="chip" :class="badgeChipClass">{{ badgeLabel }}</span>

      <span v-if="event.kind && event.kind !== 'task'" class="chip" :class="event.kind === 'ag-ui-tool' ? 'chip-violet' : 'chip-cyan'">
        {{ kindLabel }}
      </span>

      <span v-if="event.clientName" class="chip chip-violet" style="font-size:8px;">{{ event.clientName }}</span>

      <span style="font-size:9px;color:var(--text-ghost);font-variant-numeric:tabular-nums;margin-left:auto;flex-shrink:0;">{{ formattedTime }}</span>
    </div>

    <!-- Row 2: identity / conversation -->
    <div style="margin-top:3px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span style="font-size:9px;color:var(--text-ghost);font-variant-numeric:tabular-nums;">{{ shortTaskId }}</span>
      <span v-if="event.conversationId" style="font-size:9px;color:var(--text-ghost);font-variant-numeric:tabular-nums;">conv {{ shortConversationId }}</span>
      <span v-if="channelSummary" style="font-size:9px;color:var(--text-dim);">{{ channelSummary }}</span>
    </div>

    <!-- Tool args preview -->
    <div v-if="event.kind === 'ag-ui-tool' && event.toolCallArgs" style="margin-top:6px;">
      <pre style="font-family:var(--font);font-size:9px;color:var(--text-dim);background:var(--surface-0);border:1px solid var(--border-dim);border-radius:2px;padding:4px 6px;white-space:pre-wrap;word-break:break-all;margin:0;">{{ argsPreview }}</pre>
    </div>

    <!-- Expanded payload -->
    <div v-if="event.expanded && event.payload" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-dim);">
      <PayloadViewer :data="event.payload" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useTraceStore } from "@/stores/trace";
import PayloadViewer from "./PayloadViewer.vue";
import { formatTimestamp } from "@/lib/utils";
import type { TraceEvent } from "@/types";

const props = defineProps<{ event: TraceEvent }>();
const store = useTraceStore();

const formattedTime = computed(() => formatTimestamp(props.event.timestamp));
const shortTaskId = computed(() => props.event.taskId.slice(0, 8) + "…");
const shortConversationId = computed(() => props.event.conversationId?.slice(0, 8) + "…");

const borderClass = computed(() => {
  if (props.event.kind === "ag-ui-tool") return "border-l-indigo";
  if (props.event.kind === "ag-ui-step") return "border-l-sky";
  if (props.event.kind === "channel-message") return "border-l-violet";
  if (props.event.kind === "channel-ack") return "border-l-cyan";
  const map: Record<string, string> = {
    submitted: "border-l-blue",
    working:   "border-l-amber",
    "input-required": "border-l-violet",
    completed: "border-l-emerald",
    failed:    "border-l-red",
    canceled:  "border-l-dim",
  };
  return map[props.event.state] ?? "border-l-dim";
});

const badgeLabel = computed(() => {
  if (props.event.kind === "ag-ui-tool") return props.event.toolCallName;
  if (props.event.kind === "ag-ui-step") return props.event.stepName;
  if (props.event.kind === "channel-ack") return props.event.channelState;
  return props.event.skillId;
});
const badgeChipClass = computed(() => {
  if (props.event.kind === "ag-ui-tool") return "chip-violet";
  if (props.event.kind === "ag-ui-step") return "chip-cyan";
  if (props.event.kind === "channel-message") return "chip-violet";
  if (props.event.kind === "channel-ack") return props.event.channelState === "failed" ? "chip-red" : "chip-cyan";
  return "chip-dim";
});

const kindLabel = computed(() => {
  if (props.event.kind === "ag-ui-tool") return "tool";
  if (props.event.kind === "ag-ui-step") return "step";
  if (props.event.kind === "channel-message") return props.event.direction === "incoming" ? "channel in" : "channel out";
  if (props.event.kind === "channel-ack") return "ack";
  return props.event.kind;
});

const channelSummary = computed(() => {
  if (props.event.kind === "channel-message") {
    return props.event.replyTo ? `reply ${props.event.replyTo.slice(0, 8)}…` : "new message";
  }
  if (props.event.kind === "channel-ack") {
    return props.event.messageId ? `msg ${props.event.messageId.slice(0, 8)}…` : "";
  }
  return "";
});

const argsPreview = computed(() => {
  const args = props.event.toolCallArgs;
  if (!args) return "";
  const str = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  return str.length > 200 ? str.slice(0, 200) + "…" : str;
});
</script>

<style scoped>
.trace-entry {
  padding: 7px 8px;
  border-radius: 3px;
  background: var(--surface-1);
  border: 1px solid var(--border-dim);
  border-left-width: 2px;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.trace-entry:hover { background: var(--surface-2); }

.border-l-blue    { border-left-color: var(--blue); }
.border-l-amber   { border-left-color: var(--amber); }
.border-l-emerald { border-left-color: var(--emerald); }
.border-l-red     { border-left-color: var(--red); }
.border-l-indigo  { border-left-color: var(--indigo); }
.border-l-sky     { border-left-color: var(--sky); }
.border-l-violet  { border-left-color: var(--violet); }
.border-l-dim     { border-left-color: var(--border-mid); }
</style>
