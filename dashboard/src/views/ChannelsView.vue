<template>
  <div class="app-shell">
    <AppHeader />
    <div class="app-frame channels-grid">
      <div class="app-column">
        <div class="panel-header">
          <div class="panel-heading">
            <span class="panel-label">Channels</span>
            <span class="panel-sublabel">persistent conversation threads moving across passive client sessions and agents</span>
          </div>
          <button class="btn-ghost" @click="reload">reload</button>
        </div>

        <div class="toolbar">
          <label class="toolbar-field channel-scope-field">
            <span class="toolbar-label">Scope</span>
            <input v-model="pendingOnly" type="checkbox" />
            <span class="channel-scope-text">Pending only</span>
          </label>
          <label class="toolbar-field channel-scope-field">
            <span class="toolbar-label">Focus</span>
            <input v-model="showExpiredOnly" type="checkbox" />
            <span class="channel-scope-text">Expired only</span>
          </label>
        </div>

        <div v-if="loading" class="empty-state">
          <p class="empty-state__title">Loading conversations…</p>
        </div>
        <div v-else-if="error" class="empty-state">
          <p class="empty-state__title">Channel load failed</p>
          <p class="empty-state__body">{{ error }}</p>
        </div>
        <div v-else-if="conversations.length === 0" class="empty-state">
          <div class="empty-state__icon">◌</div>
          <p class="empty-state__title">No conversations yet</p>
          <p class="empty-state__body">When a message is sent through a client channel, the full thread will appear here with delivery acknowledgements.</p>
        </div>
        <div v-else class="scrollable conversation-list">
          <button
            v-for="conversation in conversations"
            :key="conversation.conversationId"
            class="sig-card sig-card--button"
            :class="selectedId === conversation.conversationId ? 'conversation-active' : ''"
            @click="selectConversation(conversation.conversationId)"
          >
            <div class="conversation-item__head">
              <span class="conversation-item__sender">{{ conversation.lastMessage.fromAgentName ?? conversation.lastMessage.fromAgentId }}</span>
              <span class="chip" :class="statusClass(conversation.status)">
                {{ conversation.status ?? (conversation.pendingReply ? 'pending' : (conversation.lastAckState ?? 'idle')) }}
              </span>
              <span v-if="conversation.pendingCount" class="chip chip-cyan">{{ conversation.pendingCount }} pending</span>
            </div>
            <div class="conversation-item__token conversation-item__token--spaced">
              {{ conversation.conversationId.slice(0, 8) }}… · {{ formatTime(conversation.lastMessage.createdAt) }}
            </div>
            <div class="conversation-item__preview conversation-item__preview--singleline">
              {{ conversation.lastMessage.content }}
            </div>
          </button>
        </div>
      </div>

      <div class="app-column">
        <div class="panel-header">
          <div class="panel-heading">
            <span class="panel-label">Conversation</span>
            <span class="panel-sublabel">{{ selectedId ? selectedId.slice(0, 8) + '…' : 'select a thread' }}</span>
          </div>
        </div>

        <div v-if="selectedLoading" class="empty-state">
          <p class="empty-state__title">Loading conversation…</p>
        </div>
        <div v-else-if="selectedError" class="empty-state">
          <p class="empty-state__title">Conversation load failed</p>
          <p class="empty-state__body">{{ selectedError }}</p>
        </div>
        <div v-else-if="!selected" class="empty-state">
          <div class="empty-state__icon">↗</div>
          <p class="empty-state__title">Select a conversation</p>
          <p class="empty-state__body">Choose a thread on the left to inspect the ordered message flow and delivery acknowledgements.</p>
        </div>
        <div v-else class="scrollable conversation-columns">
          <section class="sig-card sig-card--soft">
            <div class="conversation-actions">
              <button class="btn-ghost" @click="reload">refresh</button>
              <button class="btn-ghost" @click="handleSuppress" :disabled="conversationActionLoading">suppress</button>
              <button class="btn-ghost" @click="handleRevive" :disabled="conversationActionLoading">revive</button>
            </div>
            <div class="field-note conversation-section-title">Messages</div>
            <div class="conversation-stack">
              <div v-for="message in selected.messages" :key="message.messageId" class="message-card">
                <div class="message-card__head">
                  <span class="message-card__sender">{{ message.fromAgentName ?? message.fromAgentId }}</span>
                  <span class="chip chip-violet">{{ message.kind }}</span>
                  <span v-if="message.toAgentId" class="chip chip-cyan">to {{ message.toAgentId.slice(0, 8) }}…</span>
                  <span class="message-card__time">{{ formatTime(message.createdAt) }}</span>
                </div>
                <div class="message-card__token">
                  msg {{ message.messageId.slice(0, 8) }}…<span v-if="message.replyTo"> · reply {{ message.replyTo.slice(0, 8) }}…</span>
                </div>
                <pre class="message-pre">{{ message.content }}</pre>
              </div>
            </div>
          </section>

          <section class="sig-card sig-card--soft">
            <div class="field-note conversation-section-title">Acknowledgements</div>
            <div v-if="selected.acknowledgements.length === 0" class="empty-state conversation-empty">
              <p class="empty-state__body">No acknowledgements yet.</p>
            </div>
            <div v-else class="conversation-stack">
              <div v-for="ack in selected.acknowledgements" :key="`${ack.messageId}-${ack.timestamp}-${ack.state}`" class="ack-card">
                <div class="ack-card__head">
                  <span class="chip" :class="ack.state === 'failed' ? 'chip-red' : ack.state === 'answered' ? 'chip-emerald' : 'chip-cyan'">{{ ack.state }}</span>
                  <span class="message-card__sender">{{ ack.actorType }}</span>
                  <span class="message-card__token">{{ ack.actorId }}</span>
                </div>
                <div class="ack-card__token">
                  msg {{ ack.messageId.slice(0, 8) }}… · {{ formatTime(ack.timestamp) }}
                </div>
                <div v-if="ack.detail" class="ack-card__detail">{{ ack.detail }}</div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import AppHeader from "@/components/layout/AppHeader.vue";
import { dashboardChannelRuntime } from "@/lib/channel-runtime";
import {
  fetchChannelConversation,
  fetchChannelConversations,
  reviveChannelConversation,
  suppressChannelConversation,
} from "@/lib/registry-client";
import type { ChannelAckPayload, ChannelConversationListEntry, ChannelConversationSnapshot, ChannelMessagePayload, WsMessage } from "@/types";

const conversations = ref<ChannelConversationListEntry[]>([]);
const selected = ref<ChannelConversationSnapshot | null>(null);
const selectedId = ref<string | null>(null);
const loading = ref(false);
const selectedLoading = ref(false);
const conversationActionLoading = ref(false);
const error = ref<string | null>(null);
const selectedError = ref<string | null>(null);
const pendingOnly = ref(false);
const showExpiredOnly = ref(false);
let stopRegistryListener: (() => void) | null = null;
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString();
}

function statusClass(status?: string): string {
  if (status === "pending") return "chip-violet";
  if (status === "expired" || status === "failed") return "chip-red";
  if (status === "answered") return "chip-emerald";
  return "chip-dim";
}

function matchesFilters(conversation: ChannelConversationListEntry): boolean {
  if (pendingOnly.value && !conversation.pendingReply) return false;
  if (showExpiredOnly.value && !(conversation.status === "expired" || conversation.expired)) return false;
  return true;
}

function insertOrReplaceConversation(conversation: ChannelConversationListEntry) {
  const next = conversations.value.filter((item) => item.conversationId !== conversation.conversationId);
  if (matchesFilters(conversation)) {
    next.push(conversation);
  }
  next.sort((a, b) => b.lastMessage.createdAt - a.lastMessage.createdAt);
  conversations.value = next;
  if (selectedId.value && !next.some((item) => item.conversationId === selectedId.value)) {
    selected.value = null;
    selectedId.value = null;
  }
}

function buildSummary(snapshot: ChannelConversationSnapshot): ChannelConversationListEntry {
  const lastMessage = snapshot.messages[snapshot.messages.length - 1]!;
  const latestAckByMessage = new Map<string, ChannelAckPayload>();

  for (const ack of snapshot.acknowledgements) {
    latestAckByMessage.set(ack.messageId, ack);
  }

  const pendingMessages = snapshot.messages.filter((message) => {
    if (!message.expectsResponse) return false;
    const lastAck = latestAckByMessage.get(message.messageId);
    return lastAck?.state !== "answered" && lastAck?.state !== "failed";
  });

  const expired = pendingMessages.some((message) => message.expiresAt && message.expiresAt <= Date.now());
  const lastAckState = snapshot.acknowledgements.length > 0
    ? snapshot.acknowledgements[snapshot.acknowledgements.length - 1]!.state
    : undefined;

  let status: ChannelConversationListEntry["status"] = "active";
  if (expired) status = "expired";
  else if (pendingMessages.length > 0) status = "pending";
  else if (lastAckState === "failed") status = "failed";
  else if (lastAckState === "answered") status = "answered";

  return {
    conversationId: snapshot.conversationId,
    lastMessage,
    pendingReply: pendingMessages.length > 0 && !expired,
    expired,
    lastAckState,
    pendingCount: pendingMessages.length,
    pendingMessageIds: pendingMessages.map((message) => message.messageId),
    status,
  };
}

async function reload() {
  loading.value = true;
  error.value = null;
  try {
    const all = await fetchChannelConversations({ pending: pendingOnly.value });
    conversations.value = showExpiredOnly.value
      ? all.filter((conversation) => conversation.status === "expired" || conversation.expired)
      : all;
    if (selectedId.value && conversations.value.some((item) => item.conversationId === selectedId.value)) {
      await selectConversation(selectedId.value);
    } else if (conversations.value.length > 0) {
      await selectConversation(conversations.value[0].conversationId);
    } else {
      selected.value = null;
      selectedId.value = null;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function selectConversation(conversationId: string) {
  selectedId.value = conversationId;
  selectedLoading.value = true;
  selectedError.value = null;
  try {
    selected.value = await fetchChannelConversation(conversationId);
  } catch (err) {
    selectedError.value = err instanceof Error ? err.message : String(err);
  } finally {
    selectedLoading.value = false;
  }
}

async function refreshConversation(conversationId: string) {
  try {
    const snapshot = await fetchChannelConversation(conversationId);
    if (selectedId.value === conversationId) {
      selected.value = snapshot;
    }
    insertOrReplaceConversation(buildSummary(snapshot));
  } catch {
    conversations.value = conversations.value.filter((item) => item.conversationId !== conversationId);
    if (selectedId.value === conversationId) {
      selected.value = null;
      selectedId.value = null;
    }
  }
}

async function handleSuppress() {
  if (!selectedId.value) return;
  conversationActionLoading.value = true;
  selectedError.value = null;
  try {
    await suppressChannelConversation(selectedId.value);
    selected.value = null;
    selectedId.value = null;
    await reload();
  } catch (err) {
    selectedError.value = err instanceof Error ? err.message : String(err);
  } finally {
    conversationActionLoading.value = false;
  }
}

async function handleRevive() {
  if (!selectedId.value) return;
  conversationActionLoading.value = true;
  selectedError.value = null;
  try {
    await reviveChannelConversation(selectedId.value);
    await reload();
    await selectConversation(selectedId.value);
  } catch (err) {
    selectedError.value = err instanceof Error ? err.message : String(err);
  } finally {
    conversationActionLoading.value = false;
  }
}

function scheduleConversationRefresh(conversationId: string) {
  const existing = refreshTimers.get(conversationId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    refreshTimers.delete(conversationId);
    void refreshConversation(conversationId);
  }, 180);
  refreshTimers.set(conversationId, timer);
}

function handleRegistryEvent(msg: WsMessage) {
  if (msg.type === "channel.message" || msg.type === "channel.ack") {
    scheduleConversationRefresh(msg.data.conversationId);
    return;
  }

  if (msg.type === "channel.conversation.suppressed") {
    conversations.value = conversations.value.filter((item) => item.conversationId !== msg.data.conversationId);
    if (selectedId.value === msg.data.conversationId) {
      selected.value = null;
      selectedId.value = null;
    }
    return;
  }

  if (msg.type === "channel.conversation.revived") {
    scheduleConversationRefresh(msg.data.conversationId);
  }
}

watch([pendingOnly, showExpiredOnly], () => {
  void reload();
});

onMounted(() => {
  stopRegistryListener = dashboardChannelRuntime.on("registry", handleRegistryEvent);
  void reload();
});

onUnmounted(() => {
  stopRegistryListener?.();
  stopRegistryListener = null;
  for (const timer of refreshTimers.values()) {
    clearTimeout(timer);
  }
  refreshTimers.clear();
});
</script>

<style scoped>
.channel-scope-field {
  min-width: 0;
}

.channel-scope-text {
  font-size: 0.95rem;
  color: rgba(39, 29, 25, 0.66);
}

.conversation-item__token--spaced {
  margin-top: 8px;
}

.conversation-item__preview--singleline {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conversation-section-title {
  margin-bottom: 12px;
}

.conversation-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-bottom: 12px;
}

.conversation-empty {
  padding: 24px 12px;
}

/* Fix: dark card (sig-card) background needs light text */
.conversation-list .conversation-item__sender {
  color: var(--text);
}

.conversation-list .conversation-item__token {
  color: rgba(255, 247, 237, 0.46);
}

.conversation-list .conversation-item__preview {
  color: rgba(255, 247, 237, 0.65);
}
</style>
