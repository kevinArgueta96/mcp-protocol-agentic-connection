<template>
  <div v-if="message.role === 'system'" class="tool-card fade-in system-card">
    <div class="tool-card__title system-card__title">
      <span class="tool-avatar">!</span>
      <span>channel status</span>
    </div>
    <p class="chat-copy system-card__copy">{{ message.content }}</p>
    <span class="message-time tool-time">{{ time }}</span>
  </div>

  <div v-else-if="message.role === 'tool'" class="tool-card fade-in">
    <div class="tool-card__title">
      <span class="tool-avatar">T</span>
      <span>{{ message.toolCall?.name ?? "tool" }}</span>
      <span v-if="message.toolCall?.streaming" class="cursor-blink">■</span>
    </div>

    <div v-if="message.toolCall?.argsRaw || message.toolCall?.args" class="tool-block tool-block--args">
      <span class="field-note">Args</span>
      <pre class="code-pre">{{ argsDisplay }}</pre>
    </div>

    <div v-if="message.toolCall?.result !== undefined" class="tool-block tool-block--result">
      <span class="field-note">Result</span>
      <pre class="code-pre code-pre--result">{{ resultDisplay }}</pre>
    </div>

    <span class="message-time tool-time">{{ time }}</span>
  </div>

  <div v-else class="chat-row fade-in" :class="message.role === 'user' ? 'chat-row--user' : ''">
    <span class="chat-avatar" :class="message.role === 'user' ? 'chat-avatar--user' : 'chat-avatar--agent'">
      {{ message.role === "user" ? "U" : "A" }}
    </span>
    <div class="chat-bubble" :class="message.role === 'user' ? 'chat-bubble--user' : 'chat-bubble--agent'">
      <div v-if="message.deliveryState" class="chat-message-state">
        <span class="chip" :class="deliveryChipClass">{{ deliveryLabel }}</span>
      </div>
      <span v-if="message.streaming && !message.content" class="stream-cursor cursor-blink" />
      <pre v-else-if="isJson" class="message-pre">{{ message.content }}</pre>
      <p v-else class="chat-copy">{{ message.content }}</p>
      <span v-if="message.streaming && message.content" class="cursor-blink stream-copy">▌</span>
      <span class="message-time bubble-time">{{ time }}</span>
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

const deliveryLabel = computed(() => {
  if (!props.message.deliveryState) return "";
  return props.message.deliveryState.replaceAll("_", " ");
});

const deliveryChipClass = computed(() => {
  switch (props.message.deliveryState) {
    case "answered":
      return "chip-emerald";
    case "failed":
      return "chip-red";
    case "displayed_to_client":
      return "chip-cyan";
    default:
      return "chip-amber";
  }
});
</script>

<style scoped>
.system-card {
  background: rgba(255, 197, 108, 0.08);
  border: 1px solid rgba(255, 197, 108, 0.22);
}

.system-card__title {
  color: #8b5a00;
}

.system-card__copy {
  margin-top: 10px;
}

.stream-cursor {
  display: inline-block;
  width: 7px;
  height: 13px;
  background: var(--emerald);
  vertical-align: text-bottom;
}

.code-pre--result {
  color: #aaf4c0;
}

.tool-block--args {
  margin-top: 10px;
}

.tool-block--result {
  margin-top: 12px;
}

.tool-time,
.bubble-time {
  display: block;
}

.tool-time {
  margin-top: 10px;
}

.bubble-time {
  margin-top: 8px;
}

.chat-copy {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.stream-copy {
  margin-left: 2px;
}

.chat-message-state {
  margin-bottom: 8px;
}
</style>
