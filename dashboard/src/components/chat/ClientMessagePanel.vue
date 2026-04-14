<template>
  <div class="panel">
    <div class="panel-header">
      <div class="panel-heading">
        <span class="panel-label">Messages</span>
        <span class="panel-sublabel">
          {{ selectedClient ? selectedClient.projectName : "select a client from the left" }}
        </span>
      </div>
      <button v-if="chatStore.messages.length > 0" class="btn-ghost" @click="startFresh">
        history
      </button>
    </div>

    <div class="chat-panel__selector">
      <AgentSelector />
    </div>

    <!-- No client selected -->
    <div v-if="!selectedClient" class="empty-state flex-grow">
      <div class="empty-state__icon">⬡</div>
      <p class="empty-state__title">Pick a client session</p>
      <p class="empty-state__body">Click any client in the left panel to open its conversation history. You can send new messages and see past replies.</p>
    </div>

    <template v-else>
      <!-- History view: no active messages yet, show past conversations -->
      <template v-if="chatStore.messages.length === 0">
        <div v-if="historyLoading" class="history-state">
          <span class="history-spinner" />
          <span class="history-hint">Loading history…</span>
        </div>

        <div v-else-if="clientConversations.length === 0" class="empty-state flex-grow">
          <div class="empty-state__icon">✦</div>
          <p class="empty-state__title">Ready for {{ selectedClient.projectName }}</p>
          <p class="empty-state__body">No past conversations found. Send the first message to start a thread.</p>
        </div>

        <div v-else class="scrollable history-list" ref="historyEl">
          <div class="history-label">
            <span>Past conversations</span>
            <span class="history-count">{{ clientConversations.length }}</span>
          </div>
          <div
            v-for="conv in clientConversations"
            :key="conv.conversationId"
            class="history-conv-card"
          >
            <div class="history-conv-head">
              <span class="history-conv-from">{{ conv.lastMessage.fromAgentName ?? conv.lastMessage.fromAgentId }}</span>
              <span class="chip chip--nano" :class="convStatusClass(conv.status)">{{ conv.status ?? 'active' }}</span>
              <span class="history-conv-time">{{ formatTime(conv.lastMessage.createdAt) }}</span>
            </div>
            <p class="history-conv-preview">{{ conv.lastMessage.content }}</p>
          </div>
        </div>
      </template>

      <!-- Active session: live messages -->
      <div v-else ref="messagesEl" class="scrollable chat-list">
        <ChatMessage v-for="msg in chatStore.messages" :key="msg.id" :message="msg" />
      </div>

      <div v-if="chatStore.error" class="error-banner">
        {{ chatStore.error }}
      </div>

      <!-- Compose box -->
      <div class="chat-box">
        <div class="chat-box__head">
          <div class="panel-heading chat-compose-heading">
            <span class="field-note">
              {{ chatStore.messages.length > 0 ? 'Continue conversation' : 'New message' }}
            </span>
            <span class="panel-sublabel chat-compose-subtitle">
              → {{ selectedClient.projectName }}
            </span>
          </div>
          <div class="chat-box-actions">
            <!-- Template picker -->
            <div class="select-wrap template-select-wrap">
              <select class="sig-select sig-select--xs" @change="applyTemplate">
                <option value="">template…</option>
                <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.label }}</option>
              </select>
              <span class="select-caret">▾</span>
            </div>
            <button
              v-if="chatStore.messages.length > 0"
              class="btn-ghost btn-ghost--sm"
              :disabled="chatStore.isStreaming"
              @click="sendReminder()"
            >
              remind
            </button>
          </div>
        </div>
        <div class="chat-input">
          <textarea
            ref="inputEl"
            v-model="input"
            rows="1"
            class="chat-textarea"
            :placeholder="`Message ${selectedClient.projectName}…`"
            :disabled="chatStore.isStreaming"
            @focus="focused = true"
            @blur="focused = false"
            @keydown.enter.exact.prevent="submit"
            @keydown.enter.shift.exact="() => {}"
            @input="autoResize"
          />
          <button class="chat-send" :class="canSend ? 'chat-send--on' : ''" :disabled="!canSend" @click="submit">
            <span v-if="chatStore.isStreaming" class="cursor-blink">■</span>
            <span v-else>↑</span>
          </button>
        </div>
        <p class="chat-box__hint">Enter to send · Shift+Enter for newline</p>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useChatStore } from "@/stores/chat";
import { useRegistryStore } from "@/stores/registry";
import { dashboardChannelRuntime } from "@/lib/channel-runtime";
import { fetchChannelConversations } from "@/lib/registry-client";
import { MESSAGE_TEMPLATES } from "@/lib/message-templates";
import AgentSelector from "./AgentSelector.vue";
import ChatMessage from "./ChatMessage.vue";
import type { ChannelConversationListEntry, WsMessage } from "@/types";

const chatStore = useChatStore();
const registryStore = useRegistryStore();
const templates = MESSAGE_TEMPLATES;

const input = ref("");
const inputEl = ref<HTMLTextAreaElement | null>(null);
const messagesEl = ref<HTMLElement | null>(null);
const historyEl = ref<HTMLElement | null>(null);
const focused = ref(false);
const historyLoading = ref(false);
const clientConversations = ref<ChannelConversationListEntry[]>([]);

const selectedClient = computed(() => chatStore.selectedClient);

// If the selected client's project has a bridge daemon, route messages through it instead.
const effectiveTargetId = computed<string | undefined>(() => {
  const client = selectedClient.value;
  if (!client) return undefined;
  const bridge = registryStore.agentList.find(
    (a) =>
      a.entryType === "client" &&
      a.clientInfo?.clientVersion === "app-server-bridge" &&
      a.projectPath === client.projectPath,
  );
  return bridge?.agentId ?? undefined;
});
const canSend = computed(
  () => !!selectedClient.value && !chatStore.isStreaming && input.value.trim().length > 0,
);

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

function convStatusClass(status?: string): string {
  if (status === "pending") return "chip-violet";
  if (status === "expired" || status === "failed") return "chip-red";
  if (status === "answered") return "chip-emerald";
  return "chip-dim";
}

async function loadClientHistory(agentId: string): Promise<void> {
  historyLoading.value = true;
  clientConversations.value = [];
  try {
    const all = await fetchChannelConversations();
    clientConversations.value = all
      .filter((conv) => {
        const msg = conv.lastMessage;
        return msg.fromAgentId === agentId || msg.toAgentId === agentId;
      })
      .slice(0, 20);
  } catch {
    clientConversations.value = [];
  } finally {
    historyLoading.value = false;
  }
}

function startFresh(): void {
  chatStore.clearMessages();
  if (selectedClient.value) {
    void loadClientHistory(selectedClient.value.agentId);
  }
}

async function submit(): Promise<void> {
  if (!canSend.value) return;
  const text = input.value.trim();
  input.value = "";
  await nextTick();
  autoResize();
  await chatStore.sendMessage(text, effectiveTargetId.value);
}

async function sendReminder(): Promise<void> {
  await chatStore.sendReminder(effectiveTargetId.value);
}

function applyTemplate(e: Event): void {
  const id = (e.target as HTMLSelectElement).value;
  if (!id) return;
  const t = templates.find((t) => t.id === id);
  if (t) {
    input.value = t.body;
    nextTick(() => {
      inputEl.value?.focus();
      autoResize();
    });
  }
  (e.target as HTMLSelectElement).value = "";
}

function autoResize(): void {
  if (!inputEl.value) return;
  inputEl.value.style.height = "auto";
  inputEl.value.style.height = Math.min(inputEl.value.scrollHeight, 80) + "px";
}

watch(() => chatStore.messages.length, async () => {
  await nextTick();
  if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
});

watch(selectedClient, (client) => {
  clientConversations.value = [];
  if (client) {
    void loadClientHistory(client.agentId);
  }
});

function handleRegistryEvent(msg: WsMessage): void {
  if (msg.type !== "channel.message" && msg.type !== "channel.ack") return;
  if (!selectedClient.value || chatStore.messages.length > 0) return;
  const agentId = selectedClient.value.agentId;
  const relevant = clientConversations.value.some((c) => c.conversationId === msg.data.conversationId);
  if (relevant) {
    void loadClientHistory(agentId);
  }
}

let stopRegistryListener: (() => void) | null = null;

onMounted(() => {
  if (selectedClient.value) {
    void loadClientHistory(selectedClient.value.agentId);
  }
  stopRegistryListener = dashboardChannelRuntime.on("registry", handleRegistryEvent);
});

onUnmounted(() => {
  stopRegistryListener?.();
  stopRegistryListener = null;
});
</script>

<style scoped>
.flex-grow {
  flex: 1;
}

.chat-compose-heading {
  gap: 2px;
}

.chat-compose-subtitle {
  color: var(--text-dim);
}

.chat-box-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.btn-ghost--sm {
  min-height: 32px;
  padding: 0 10px;
  font-size: 0.82rem;
}

.history-state {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px 22px;
  color: var(--text-dim);
  font-size: 0.88rem;
}

.history-spinner {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 2px solid rgba(39, 29, 25, 0.15);
  border-top-color: rgba(39, 29, 25, 0.5);
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.history-hint {
  font-size: 0.84rem;
  color: rgba(39, 29, 25, 0.5);
}

.history-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
}

.history-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(39, 29, 25, 0.45);
  padding: 0 4px 8px;
  border-bottom: 1px solid rgba(72, 55, 46, 0.1);
}

.history-count {
  font-variant-numeric: tabular-nums;
}

.history-conv-card {
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(72, 55, 46, 0.1);
  background: rgba(255, 249, 242, 0.6);
  transition: all 0.15s ease;
}

.history-conv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.history-conv-from {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--text-ink);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-conv-time {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  color: rgba(39, 29, 25, 0.4);
  flex-shrink: 0;
}

.history-conv-preview {
  margin: 0;
  font-size: 0.8rem;
  color: rgba(39, 29, 25, 0.58);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

.chip--nano {
  font-size: 0.62rem;
  min-height: 20px;
  padding: 0 7px;
}

.error-banner {
  padding: 10px 16px;
  font-size: 0.84rem;
  color: var(--red);
  background: rgba(255, 140, 124, 0.06);
  border-top: 1px solid rgba(255, 140, 124, 0.14);
}

.template-select-wrap {
  max-width: 120px;
  flex-shrink: 0;
}

.sig-select--xs {
  font-size: 0.72rem;
  padding: 2px 20px 2px 7px;
  min-height: 28px;
}
</style>
