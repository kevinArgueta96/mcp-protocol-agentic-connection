<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- Panel header -->
    <div class="flex items-center justify-between px-3 py-2 border-b border-white/5 shrink-0">
      <span class="font-mono text-[10px] text-white/40 uppercase tracking-wider">Chat</span>
      <button
        v-if="messages.length > 0"
        class="text-[9px] font-mono text-white/20 hover:text-white/50 transition-colors"
        @click="chatStore.clearMessages()"
      >
        clear
      </button>
    </div>

    <!-- Agent selector -->
    <div class="px-3 pt-2 pb-2 border-b border-white/5 shrink-0">
      <AgentSelector />
    </div>

    <!-- No agent selected state -->
    <div
      v-if="!selectedAgent"
      class="flex flex-col items-center justify-center flex-1 px-4 text-center"
    >
      <p class="text-white/25 text-xs font-mono">Select an agent to start chatting</p>
    </div>

    <!-- Messages -->
    <div
      v-else
      ref="messagesEl"
      class="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-3"
    >
      <div
        v-if="messages.length === 0"
        class="flex flex-col items-center justify-center h-full text-center"
      >
        <p class="text-white/25 text-xs font-mono">
          Chatting with <span class="text-white/50">{{ selectedAgent.projectName }}</span>
        </p>
        <p class="text-white/15 text-[10px] mt-1 font-mono">
          Try: "list files" or "find endpoints"
        </p>
      </div>

      <ChatMessage
        v-for="msg in messages"
        :key="msg.id"
        :message="msg"
      />
    </div>

    <!-- Error banner -->
    <div
      v-if="error"
      class="mx-3 mb-2 px-2 py-1.5 rounded border border-red-500/30 bg-red-500/10 text-[10px] font-mono text-red-400 shrink-0"
    >
      {{ error }}
    </div>

    <!-- Input -->
    <div class="px-3 pb-3 shrink-0">
      <div class="flex items-end gap-2 bg-white/4 border border-white/10 rounded-lg px-3 py-2 focus-within:border-white/20 transition-colors">
        <textarea
          ref="inputEl"
          v-model="input"
          rows="1"
          class="flex-1 bg-transparent text-xs font-mono text-white/80 placeholder-white/25 resize-none focus:outline-none"
          placeholder="Send a message..."
          :disabled="!selectedAgent || isStreaming"
          @keydown.enter.exact.prevent="submit"
          @keydown.enter.shift.exact="() => {}"
          @input="autoResize"
        />
        <button
          class="shrink-0 w-6 h-6 rounded flex items-center justify-center transition-colors"
          :class="canSend
            ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
            : 'bg-white/5 text-white/20 cursor-not-allowed'"
          :disabled="!canSend"
          @click="submit"
        >
          <span class="text-[10px]">↑</span>
        </button>
      </div>
      <p class="mt-1 text-[9px] text-white/20 font-mono">Enter to send · Shift+Enter for newline</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useChatStore } from "@/stores/chat";
import AgentSelector from "./AgentSelector.vue";
import ChatMessage from "./ChatMessage.vue";

const chatStore = useChatStore();
const input = ref("");
const inputEl = ref<HTMLTextAreaElement | null>(null);
const messagesEl = ref<HTMLElement | null>(null);

const messages = computed(() => chatStore.messages);
const selectedAgent = computed(() => chatStore.selectedAgent);
const isStreaming = computed(() => chatStore.isStreaming);
const error = computed(() => chatStore.error);

const canSend = computed(() =>
  !!selectedAgent.value && !isStreaming.value && input.value.trim().length > 0
);

async function submit() {
  if (!canSend.value) return;
  const text = input.value.trim();
  input.value = "";
  await nextTick();
  autoResize();
  await chatStore.sendMessage(text);
}

function autoResize() {
  if (!inputEl.value) return;
  inputEl.value.style.height = "auto";
  inputEl.value.style.height = Math.min(inputEl.value.scrollHeight, 80) + "px";
}

// Scroll to bottom on new messages
watch(
  () => messages.value.length,
  async () => {
    await nextTick();
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
    }
  }
);
</script>
