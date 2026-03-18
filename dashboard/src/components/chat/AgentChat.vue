<template>
  <div class="panel" style="--panel-color: var(--emerald);">

    <div class="panel-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="panel-label">Chat</span>
        <span class="panel-sublabel">ask an agent</span>
      </div>
      <button v-if="messages.length > 0" class="btn-ghost" style="font-size:9px;padding:1px 6px;" @click="chatStore.clearMessages()">
        clear
      </button>
    </div>

    <!-- Agent selector -->
    <div style="padding:7px 10px;border-bottom:1px solid var(--border-dim);flex-shrink:0;">
      <AgentSelector />
    </div>

    <!-- No agent selected -->
    <div v-if="!selectedAgent" style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:8px;padding:16px;text-align:center;">
      <span style="font-size:24px;opacity:0.08;">⬡</span>
      <p style="font-size:11px;color:var(--text-mid);font-weight:600;margin:0;">Select an agent</p>
      <p style="font-size:10px;color:var(--text-ghost);margin:0;">Choose a skill agent above to start chatting</p>
    </div>

    <!-- Messages -->
    <div v-else ref="messagesEl" class="scrollable" style="padding:10px;display:flex;flex-direction:column;gap:8px;">
      <div v-if="messages.length === 0" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80px;text-align:center;gap:6px;">
        <p style="font-size:11px;color:var(--text-dim);margin:0;">
          Chatting with <span style="color:var(--text);">{{ selectedAgent.projectName }}</span>
        </p>
        <p style="font-size:10px;color:var(--text-ghost);margin:0;">Try: "list files" · "find endpoints"</p>
      </div>
      <ChatMessage v-for="msg in messages" :key="msg.id" :message="msg" />
    </div>

    <!-- Error -->
    <div v-if="error" style="margin:0 10px 6px;padding:6px 10px;border-radius:3px;border:1px solid color-mix(in srgb,var(--red) 40%,transparent);background:color-mix(in srgb,var(--red) 8%,transparent);font-size:10px;color:var(--red);flex-shrink:0;">
      {{ error }}
    </div>

    <!-- Input -->
    <div style="padding:8px 10px 10px;flex-shrink:0;">
      <div class="input-box" :class="{ 'input-box--focus': focused }">
        <textarea
          ref="inputEl"
          v-model="input"
          rows="1"
          class="chat-textarea"
          placeholder="Send a message…"
          :disabled="!selectedAgent || isStreaming"
          @focus="focused = true"
          @blur="focused = false"
          @keydown.enter.exact.prevent="submit"
          @keydown.enter.shift.exact="() => {}"
          @input="autoResize"
        />
        <button class="send-btn" :class="canSend ? 'send-btn--on' : ''" :disabled="!canSend" @click="submit">
          <span v-if="isStreaming" class="cursor-blink" style="font-size:9px;">■</span>
          <span v-else>↑</span>
        </button>
      </div>
      <p style="margin:4px 0 0;font-size:9px;color:var(--text-ghost);text-align:right;">Enter to send · Shift+Enter for newline</p>
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
const focused = ref(false);

const messages = computed(() => chatStore.messages);
const selectedAgent = computed(() => chatStore.selectedAgent);
const isStreaming = computed(() => chatStore.isStreaming);
const error = computed(() => chatStore.error);
const canSend = computed(() => !!selectedAgent.value && !isStreaming.value && input.value.trim().length > 0);

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

watch(() => messages.value.length, async () => {
  await nextTick();
  if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
});
</script>

<style scoped>
.input-box {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  background: var(--surface-1);
  border: 1px solid var(--border-mid);
  border-radius: 4px;
  padding: 7px 8px;
  transition: border-color 0.15s;
}
.input-box--focus { border-color: var(--emerald); }
.chat-textarea {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-family: var(--font);
  font-size: 11px;
  color: var(--text);
  resize: none;
  line-height: 1.5;
  min-height: 18px;
}
.chat-textarea::placeholder { color: var(--text-dim); }
.chat-textarea:disabled { opacity: 0.4; }
.send-btn {
  flex-shrink: 0;
  width: 24px; height: 24px;
  border-radius: 3px;
  border: 1px solid var(--border-mid);
  background: var(--surface-2);
  color: var(--text-dim);
  font-family: var(--font);
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: not-allowed;
  transition: all 0.15s;
}
.send-btn--on {
  border-color: color-mix(in srgb, var(--emerald) 50%, transparent);
  background: color-mix(in srgb, var(--emerald) 12%, transparent);
  color: var(--emerald);
  cursor: pointer;
}
.send-btn--on:hover {
  background: color-mix(in srgb, var(--emerald) 20%, transparent);
}
</style>
