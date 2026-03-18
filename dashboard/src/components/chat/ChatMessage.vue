<template>
  <!-- Tool call -->
  <div v-if="message.role === 'tool'" class="msg-tool fade-in">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
      <span class="tool-avatar">T</span>
      <span style="font-size:10px;font-weight:700;color:var(--indigo);">{{ message.toolCall?.name ?? "tool" }}</span>
      <span v-if="message.toolCall?.streaming" class="cursor-blink" style="font-size:8px;color:var(--indigo);">■</span>
    </div>

    <div v-if="message.toolCall?.argsRaw || message.toolCall?.args" style="margin-top:4px;">
      <span style="font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-dim);display:block;margin-bottom:3px;">args</span>
      <pre class="code-pre">{{ argsDisplay }}</pre>
    </div>

    <div v-if="message.toolCall?.result !== undefined" style="margin-top:6px;">
      <span style="font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--emerald);display:block;margin-bottom:3px;">result</span>
      <pre class="code-pre code-pre--result">{{ resultDisplay }}</pre>
    </div>

    <span style="font-size:9px;color:var(--text-ghost);font-variant-numeric:tabular-nums;display:block;margin-top:4px;">{{ time }}</span>
  </div>

  <!-- User / Agent -->
  <div v-else class="msg-row fade-in" :class="message.role === 'user' ? 'msg-row--user' : 'msg-row--agent'">
    <span class="avatar" :class="message.role === 'user' ? 'avatar--user' : 'avatar--agent'">
      {{ message.role === "user" ? "U" : "A" }}
    </span>
    <div class="bubble" :class="message.role === 'user' ? 'bubble--user' : 'bubble--agent'">
      <span v-if="message.streaming && !message.content" class="stream-cursor cursor-blink" />
      <pre v-else-if="isJson" style="font-family:var(--font);font-size:10px;white-space:pre-wrap;word-break:break-all;color:var(--text-mid);margin:0;">{{ message.content }}</pre>
      <p v-else style="margin:0;white-space:pre-wrap;word-break:break-word;">{{ message.content }}</p>
      <span v-if="message.streaming && message.content" class="cursor-blink" style="font-size:9px;opacity:0.7;margin-left:2px;">▌</span>
      <span style="font-size:9px;color:var(--text-ghost);font-variant-numeric:tabular-nums;display:block;margin-top:4px;">{{ time }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { formatTimestamp } from "@/lib/utils";
import type { ChatMessage } from "@/types";

const props = defineProps<{ message: ChatMessage }>();
const time = computed(() => formatTimestamp(props.message.timestamp));

const isJson = computed(() => {
  if (!props.message.content) return false;
  const t = props.message.content.trim();
  return (t.startsWith("{") || t.startsWith("[")) && t.length > 20;
});

const argsDisplay = computed(() => {
  if (props.message.toolCall?.args !== undefined)
    return typeof props.message.toolCall.args === "string"
      ? props.message.toolCall.args
      : JSON.stringify(props.message.toolCall.args, null, 2);
  return props.message.toolCall?.argsRaw ?? "";
});

const resultDisplay = computed(() => {
  const r = props.message.toolCall?.result;
  if (r === undefined) return "";
  return typeof r === "string" ? r : JSON.stringify(r, null, 2);
});
</script>

<style scoped>
/* Tool message */
.msg-tool {
  background: color-mix(in srgb, var(--indigo) 6%, var(--surface-1));
  border: 1px solid color-mix(in srgb, var(--indigo) 20%, var(--border-dim));
  border-left: 2px solid var(--indigo);
  border-radius: 3px;
  padding: 8px 10px;
}
.tool-avatar {
  width: 18px; height: 18px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--indigo) 20%, transparent);
  color: var(--indigo);
  font-size: 9px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.code-pre {
  font-family: var(--font);
  font-size: 9px;
  color: var(--text-mid);
  background: var(--surface-0);
  border: 1px solid var(--border-dim);
  border-radius: 2px;
  padding: 4px 7px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 120px;
  overflow-y: auto;
}
.code-pre--result { color: color-mix(in srgb, var(--emerald) 80%, var(--text-mid)); }

/* Row layout */
.msg-row {
  display: flex;
  gap: 7px;
  align-items: flex-start;
}
.msg-row--user { flex-direction: row-reverse; }

.avatar {
  width: 20px; height: 20px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}
.avatar--user  { background: color-mix(in srgb, var(--blue) 20%, transparent); color: var(--blue); }
.avatar--agent { background: color-mix(in srgb, var(--emerald) 15%, transparent); color: var(--emerald); }

.bubble {
  max-width: 88%;
  padding: 8px 10px;
  border-radius: 4px;
  border: 1px solid;
  font-size: 11px;
  line-height: 1.6;
}
.bubble--user {
  background: color-mix(in srgb, var(--blue) 8%, var(--surface-1));
  border-color: color-mix(in srgb, var(--blue) 25%, var(--border-dim));
  color: var(--text);
}
.bubble--agent {
  background: var(--surface-1);
  border-color: var(--border-mid);
  color: var(--text);
}
.stream-cursor {
  display: inline-block;
  width: 7px; height: 13px;
  background: var(--emerald);
  vertical-align: text-bottom;
}
</style>
