<template>
  <!-- Tool call message -->
  <div v-if="message.role === 'tool'" class="flex gap-2 fade-in flex-row">
    <!-- Tool avatar -->
    <div
      class="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[8px] font-mono font-bold mt-0.5 bg-violet-500/20 text-violet-400"
    >
      T
    </div>

    <!-- Tool bubble -->
    <div class="max-w-[85%] px-3 py-2 rounded-lg border text-xs leading-relaxed bg-violet-500/5 border-violet-500/20">
      <!-- Skill name -->
      <div class="font-mono font-semibold text-violet-400 text-[10px] mb-1">
        {{ message.toolCall?.name ?? "tool" }}
        <span v-if="message.toolCall?.streaming" class="inline-block w-1.5 h-2.5 bg-violet-400/70 animate-pulse ml-1 align-middle" />
      </div>

      <!-- Args -->
      <div v-if="message.toolCall?.argsRaw || message.toolCall?.args" class="mb-1">
        <div class="text-[9px] text-white/30 mb-0.5">args</div>
        <pre class="font-mono text-[9px] whitespace-pre-wrap break-all bg-white/3 rounded px-2 py-1 text-white/50">{{ argsDisplay }}</pre>
      </div>

      <!-- Result -->
      <div v-if="message.toolCall?.result !== undefined">
        <div class="text-[9px] text-emerald-400/60 mb-0.5">result</div>
        <pre class="font-mono text-[9px] whitespace-pre-wrap break-all bg-emerald-500/5 rounded px-2 py-1 text-emerald-300/70">{{ resultDisplay }}</pre>
      </div>

      <div class="mt-1 text-[9px] text-white/25 font-mono">{{ time }}</div>
    </div>
  </div>

  <!-- Regular user/agent message -->
  <div
    v-else
    class="flex gap-2 fade-in"
    :class="message.role === 'user' ? 'flex-row-reverse' : 'flex-row'"
  >
    <!-- Avatar -->
    <div
      class="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[8px] font-mono font-bold mt-0.5"
      :class="message.role === 'user' ? 'bg-blue-500/30 text-blue-300' : 'bg-emerald-500/20 text-emerald-400'"
    >
      {{ message.role === "user" ? "U" : "A" }}
    </div>

    <!-- Bubble -->
    <div
      class="max-w-[85%] px-3 py-2 rounded-lg border text-xs leading-relaxed"
      :class="message.role === 'user'
        ? 'bg-blue-500/10 border-blue-500/20 text-blue-100'
        : 'bg-white/4 border-white/8 text-white/80'"
    >
      <!-- Streaming cursor -->
      <span v-if="message.streaming && !message.content" class="inline-block w-2 h-3 bg-emerald-400/70 animate-pulse" />

      <!-- Content -->
      <pre
        v-else-if="isJson"
        class="font-mono text-[10px] whitespace-pre-wrap break-all text-white/60"
      >{{ message.content }}</pre>
      <p v-else class="font-sans whitespace-pre-wrap break-words">{{ message.content }}</p>

      <!-- Streaming indicator -->
      <span
        v-if="message.streaming && message.content"
        class="inline-block w-1.5 h-3 bg-emerald-400/70 animate-pulse ml-0.5 align-middle"
      />

      <!-- Timestamp -->
      <div class="mt-1 text-[9px] text-white/25 font-mono">{{ time }}</div>
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
  const trimmed = props.message.content.trim();
  return (trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 20;
});

const argsDisplay = computed(() => {
  if (props.message.toolCall?.args !== undefined) {
    return typeof props.message.toolCall.args === "string"
      ? props.message.toolCall.args
      : JSON.stringify(props.message.toolCall.args, null, 2);
  }
  return props.message.toolCall?.argsRaw ?? "";
});

const resultDisplay = computed(() => {
  const r = props.message.toolCall?.result;
  if (r === undefined) return "";
  return typeof r === "string" ? r : JSON.stringify(r, null, 2);
});
</script>
