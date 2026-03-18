<template>
  <div
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
</script>
