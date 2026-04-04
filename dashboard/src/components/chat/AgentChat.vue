<template>
  <div class="panel">
    <div class="panel-header">
      <div class="panel-heading">
        <span class="panel-label">Chat</span>
        <span class="panel-sublabel">direct task conversation with a runnable agent</span>
      </div>
      <button v-if="messages.length > 0" class="btn-ghost" @click="chatStore.clearMessages()">
        clear
      </button>
    </div>

    <div class="chat-panel__selector">
      <AgentSelector />
    </div>

    <div v-if="!selectedAgent" class="empty-state">
      <div class="empty-state__icon">⬡</div>
      <p class="empty-state__title">Select an agent</p>
      <p class="empty-state__body">Use this panel for skill agents only. Claude clients are channel targets and should be contacted through the messaging flow, not direct chat.</p>
    </div>

    <div v-else ref="messagesEl" class="scrollable chat-list">
      <div v-if="messages.length === 0" class="empty-state">
        <div class="empty-state__icon">✦</div>
        <p class="empty-state__title">Ready for {{ selectedAgent.projectName }}</p>
        <p class="empty-state__body">Try a concrete task such as “list files”, “find endpoints” or “run tests” so the agent can respond with a structured result.</p>
      </div>
      <ChatMessage v-for="msg in messages" :key="msg.id" :message="msg" />
    </div>

    <div v-if="error" class="error-banner">
      {{ error }}
    </div>

    <div class="chat-box">
      <div class="chat-box__head">
        <div class="panel-heading chat-compose-heading">
          <span class="field-note">Compose task</span>
          <span class="panel-sublabel chat-compose-subtitle">
            {{ selectedAgent ? `Targeting ${selectedAgent.projectName}` : "Pick an agent above" }}
          </span>
        </div>
      </div>
      <div class="chat-input">
        <textarea
          ref="inputEl"
          v-model="input"
          rows="1"
          class="chat-textarea"
          placeholder="Describe the task you want the agent to perform..."
          :disabled="!selectedAgent || isStreaming"
          @focus="focused = true"
          @blur="focused = false"
          @keydown.enter.exact.prevent="submit"
          @keydown.enter.shift.exact="() => {}"
          @input="autoResize"
        />
        <button class="chat-send" :class="canSend ? 'chat-send--on' : ''" :disabled="!canSend" @click="submit">
          <span v-if="isStreaming" class="cursor-blink">■</span>
          <span v-else>↑</span>
        </button>
      </div>
      <p class="chat-box__hint">Enter to send · Shift+Enter for newline</p>
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
.chat-compose-heading {
  gap: 2px;
}

.chat-compose-subtitle {
  color: var(--text-dim);
}
</style>
