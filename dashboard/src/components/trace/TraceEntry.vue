<template>
  <div class="trace-entry fade-in" :class="borderClass" @click="store.toggleExpanded(event.id)">
    <div class="trace-entry__head">
      <span class="state-badge" :class="`state-${event.state}`">{{ event.state }}</span>
      <span class="trace-entry__agent">{{ event.agentName }}</span>

      <span v-if="badgeLabel" class="chip" :class="badgeChipClass">{{ badgeLabel }}</span>

      <span v-if="event.kind && event.kind !== 'task'" class="chip" :class="event.kind === 'ag-ui-tool' ? 'chip-violet' : 'chip-cyan'">
        {{ kindLabel }}
      </span>

      <span v-if="event.clientLabel" class="chip chip-violet">{{ event.clientLabel }}</span>
      <span v-if="event.clientName" class="chip chip-dim">{{ event.clientName }}</span>

      <span class="trace-entry__time">{{ formattedTime }}</span>
    </div>

    <div class="trace-entry__meta trace-entry__meta--spaced">
      <span class="trace-entry__token">{{ shortTaskId }}</span>
      <span v-if="event.conversationId" class="trace-entry__token">conv {{ shortConversationId }}</span>
      <span v-if="clientSummary" class="trace-entry__token">{{ clientSummary }}</span>
      <span v-if="channelSummary" class="trace-entry__token">{{ channelSummary }}</span>
    </div>

    <div v-if="event.kind === 'ag-ui-tool' && event.toolCallArgs">
      <pre class="trace-code">{{ argsPreview }}</pre>
    </div>

    <div v-if="event.expanded && event.payload" class="trace-entry__expanded">
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

const clientSummary = computed(() => {
  if (!props.event.clientLabel && !props.event.clientName) return "";
  if (props.event.clientLabel && props.event.clientName) {
    return `${props.event.clientLabel} · ${props.event.clientName}`;
  }
  return props.event.clientLabel ?? props.event.clientName ?? "";
});

const argsPreview = computed(() => {
  const args = props.event.toolCallArgs;
  if (!args) return "";
  const str = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  return str.length > 200 ? str.slice(0, 200) + "…" : str;
});
</script>

<style scoped>
.border-l-blue { border-left: 6px solid var(--blue); }
.border-l-amber { border-left: 6px solid var(--amber); }
.border-l-emerald { border-left: 6px solid var(--emerald); }
.border-l-red { border-left: 6px solid var(--red); }
.border-l-indigo { border-left: 6px solid var(--indigo); }
.border-l-sky { border-left: 6px solid var(--sky); }
.border-l-violet { border-left: 6px solid var(--violet); }
.border-l-dim { border-left: 6px solid rgba(72, 55, 46, 0.24); }

.trace-entry__meta--spaced {
  margin-top: 10px;
}

.trace-entry__expanded {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid rgba(72, 55, 46, 0.12);
}
</style>
