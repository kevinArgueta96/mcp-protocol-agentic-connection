<template>
  <div class="app-shell">
    <AppHeader />
    <div class="app-frame inbox-grid">

      <!-- ── Left: Thread list ─────────────────────────────────────────────── -->
      <div class="app-column inbox-col-threads">
        <div class="panel-header">
          <div class="panel-heading">
            <span class="panel-label">Inbox</span>
            <span class="panel-sublabel">agent conversations</span>
          </div>
          <button class="btn-ghost" @click="reload">reload</button>
        </div>

        <div class="toolbar inbox-toolbar">
          <label class="toolbar-field channel-scope-field">
            <input v-model="pendingOnly" type="checkbox" />
            <span class="channel-scope-text">Pending</span>
          </label>
          <label class="toolbar-field channel-scope-field">
            <input v-model="showExpiredOnly" type="checkbox" />
            <span class="channel-scope-text">Expired</span>
          </label>
          <div class="select-wrap client-filter-wrap">
            <select v-model="clientFilter" class="sig-select sig-select--sm">
              <option value="">All clients</option>
              <option v-for="c in availableClients" :key="c" :value="c">{{ c }}</option>
            </select>
            <span class="select-caret">▾</span>
          </div>
        </div>

        <div v-if="loading" class="empty-state">
          <p class="empty-state__title">Loading…</p>
        </div>
        <div v-else-if="error" class="empty-state">
          <p class="empty-state__title">Load failed</p>
          <p class="empty-state__body">{{ error }}</p>
        </div>
        <div v-else-if="filteredConversations.length === 0" class="empty-state">
          <div class="empty-state__icon">◌</div>
          <p class="empty-state__title">No conversations yet</p>
          <p class="empty-state__body">
            Send a message from any connected client or
            <RouterLink to="/plans" class="inline-link">create a plan</RouterLink>
            to start a conversation.
          </p>
        </div>
        <div v-else class="scrollable conversation-list">
          <button
            v-for="conv in filteredConversations"
            :key="conv.conversationId"
            class="sig-card sig-card--button"
            :class="selectedId === conv.conversationId ? 'conversation-active' : ''"
            @click="selectConversation(conv.conversationId)"
          >
            <div class="conversation-item__head">
              <span class="conversation-item__sender">
                {{ conv.lastMessage.fromAgentName ?? conv.lastMessage.fromAgentId }}
              </span>
              <span class="chip" :class="statusClass(conv.status)">
                {{ conv.status ?? (conv.pendingReply ? 'pending' : (conv.lastAckState ?? 'idle')) }}
              </span>
              <span v-if="conv.pendingCount" class="chip chip-cyan">{{ conv.pendingCount }}</span>
            </div>
            <div class="conversation-item__token conversation-item__token--spaced">
              {{ conv.conversationId.slice(0, 8) }}… · {{ formatRelativeTime(conv.lastMessage.createdAt) }}
            </div>
            <div class="conversation-item__preview conversation-item__preview--singleline">
              {{ conv.lastMessage.content }}
            </div>
          </button>
        </div>
      </div>

      <!-- ── Centre: Transcript ─────────────────────────────────────────────── -->
      <div class="app-column inbox-col-transcript">
        <div class="panel-header">
          <div class="panel-heading">
            <span class="panel-label">Transcript</span>
            <span v-if="selectedId" class="panel-sublabel transcript-id">
              {{ selectedId.slice(0, 8) }}…
              <button class="copy-btn" title="Copy conversation ID" @click="copyConversationId">⎘</button>
            </span>
            <span v-else class="panel-sublabel">select a thread</span>
          </div>
          <button v-if="selected" class="btn-ghost" @click="refreshSelected">refresh</button>
        </div>

        <div v-if="selectedLoading" class="empty-state">
          <p class="empty-state__title">Loading…</p>
        </div>
        <div v-else-if="selectedError" class="empty-state">
          <p class="empty-state__title">Load failed</p>
          <p class="empty-state__body">{{ selectedError }}</p>
        </div>
        <div v-else-if="!selected" class="empty-state">
          <div class="empty-state__icon">↗</div>
          <p class="empty-state__title">Select a conversation</p>
          <p class="empty-state__body">Choose a thread on the left to see its message flow and delivery acknowledgements.</p>
        </div>
        <div v-else class="scrollable conv-timeline-wrap" ref="timelineEl">
          <div class="conv-participants">
            <span class="conv-participant-label">participants:</span>
            <span v-for="p in participants" :key="p" class="chip chip-dim conv-participant-chip">{{ p }}</span>
          </div>
          <div class="conv-timeline">
            <div
              v-for="item in unifiedTimeline"
              :key="item.type + (item.type === 'message' ? item.messageId : `${item.messageId}-${item.timestamp}-${item.state}`)"
            >
              <div v-if="item.type === 'message'" class="conv-msg-card" :class="{ 'conv-msg-card--selected': selectedMsgId === item.messageId }" @click="selectMessage(item.messageId)">
                <div class="conv-msg-header">
                  <span class="conv-msg-from">{{ item.fromAgentName ?? item.fromAgentId }}</span>
                  <span class="conv-msg-kind">{{ item.kind }}</span>
                  <span class="conv-msg-time">{{ formatTimestamp(item.createdAt) }}</span>
                  <button
                    v-if="isMessageFailed(item.messageId)"
                    class="btn-ghost btn-xs retry-btn"
                    title="Retry delivery"
                    :disabled="retryingMsgId === item.messageId"
                    @click.stop="retryMessage(item.conversationId, item.messageId)"
                  >
                    {{ retryingMsgId === item.messageId ? '…' : 'retry' }}
                  </button>
                </div>
                <pre class="conv-msg-body">{{ item.content }}</pre>
                <DeliveryProgress v-if="msgDeliveryState(item.messageId)" :state="msgDeliveryState(item.messageId)!" class="msg-delivery-progress" />
              </div>
              <div v-else class="conv-ack-pill">
                <span class="conv-ack-state" :class="`ack-${item.state}`">{{ item.state }}</span>
                <span class="conv-ack-actor">{{ item.actorType }}</span>
                <span class="conv-ack-time">{{ formatRelativeTime(item.timestamp) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Right: Actions panel ───────────────────────────────────────────── -->
      <div class="app-column inbox-col-actions">
        <div class="panel-header">
          <div class="panel-heading">
            <span class="panel-label">Actions</span>
          </div>
        </div>

        <div v-if="!selected" class="empty-state">
          <div class="empty-state__icon">⬡</div>
          <p class="empty-state__title">No thread selected</p>
        </div>

        <div v-else class="actions-body scrollable">
          <!-- Conversation actions -->
          <div class="actions-section">
            <span class="actions-section-title">Conversation</span>
            <div class="actions-row">
              <button class="btn-ghost" :disabled="conversationActionLoading" @click="handleSuppress">suppress</button>
              <button class="btn-ghost" :disabled="conversationActionLoading" @click="handleRevive">revive</button>
              <button class="btn-ghost" @click="copyConversationId">copy id</button>
            </div>
            <div v-if="actionError" class="error-banner">{{ actionError }}</div>
          </div>

          <!-- Reply composer -->
          <div class="actions-section">
            <span class="actions-section-title">Reply</span>

            <!-- Target selector -->
            <div class="toolbar-field">
              <label class="toolbar-label">To</label>
              <div class="select-wrap">
                <select v-model="replyTarget" class="sig-select sig-select--sm">
                  <option value="">Dashboard client sessions</option>
                  <option v-for="agent in replyTargets" :key="agent.agentId" :value="agent.agentId">
                    {{ agent.projectName }} · {{ agent.clientInfo?.clientName ?? agent.name }}
                  </option>
                </select>
                <span class="select-caret">▾</span>
              </div>
            </div>

            <!-- Template picker -->
            <div class="toolbar-field template-field">
              <label class="toolbar-label">Template</label>
              <div class="select-wrap">
                <select class="sig-select sig-select--sm" @change="applyTemplate">
                  <option value="">— no template —</option>
                  <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.label }}</option>
                </select>
                <span class="select-caret">▾</span>
              </div>
            </div>

            <div class="reply-compose">
              <textarea
                ref="replyInputEl"
                v-model="replyText"
                rows="3"
                class="reply-textarea"
                placeholder="Write a reply…"
                :disabled="sendingReply"
                @keydown.enter.exact.prevent="sendReply"
                @input="autoResizeReply"
              />
              <div class="reply-compose-footer">
                <span class="reply-compose-hint">Enter to send · Shift+Enter for newline</span>
                <button class="chat-send" :class="canReply ? 'chat-send--on' : ''" :disabled="!canReply" @click="sendReply">
                  <span v-if="sendingReply" class="cursor-blink">■</span>
                  <span v-else>↑</span>
                </button>
              </div>
            </div>

            <div v-if="sendReplyError" class="error-banner">{{ sendReplyError }}</div>
            <div v-if="sentConfirmation" class="sent-confirmation">{{ sentConfirmation }}</div>
          </div>

          <!-- Selected message detail -->
          <div v-if="selectedMsg" class="actions-section">
            <span class="actions-section-title">Selected message</span>
            <div class="msg-detail-table">
              <div class="msg-detail-row">
                <span class="msg-detail-key">id</span>
                <span class="msg-detail-val">{{ selectedMsg.messageId.slice(0, 8) }}…</span>
              </div>
              <div class="msg-detail-row">
                <span class="msg-detail-key">from</span>
                <span class="msg-detail-val">{{ selectedMsg.fromAgentName ?? selectedMsg.fromAgentId }}</span>
              </div>
              <div v-if="selectedMsg.toAgentId" class="msg-detail-row">
                <span class="msg-detail-key">to</span>
                <span class="msg-detail-val">{{ selectedMsg.toAgentId }}</span>
              </div>
              <div class="msg-detail-row">
                <span class="msg-detail-key">kind</span>
                <span class="msg-detail-val">{{ selectedMsg.kind }}</span>
              </div>
              <div class="msg-detail-row">
                <span class="msg-detail-key">state</span>
                <span class="msg-detail-val">{{ msgDeliveryState(selectedMsg.messageId) ?? '—' }}</span>
              </div>
              <div v-if="selectedMsg.expiresAt" class="msg-detail-row">
                <span class="msg-detail-key">expires</span>
                <span class="msg-detail-val" :class="{ 'expired-label': selectedMsg.expiresAt < Date.now() }">{{ formatTimestamp(selectedMsg.expiresAt) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import AppHeader from "@/components/layout/AppHeader.vue";
import DeliveryProgress from "@/components/chat/DeliveryProgress.vue";
import { dashboardChannelRuntime } from "@/lib/channel-runtime";
import { MESSAGE_TEMPLATES } from "@/lib/message-templates";
import {
  createChannelMessage,
  fetchChannelConversation,
  fetchChannelConversations,
  retryChannelMessage,
  reviveChannelConversation,
  suppressChannelConversation,
} from "@/lib/registry-client";
import { useRegistryStore } from "@/stores/registry";
import type {
  ChannelAckPayload,
  ChannelConversationListEntry,
  ChannelConversationSnapshot,
  ChannelDeliveryState,
  ChannelMessagePayload,
  WsMessage,
} from "@/types";
import { formatRelativeTime } from "@/lib/utils";

const registryStore = useRegistryStore();
const route = useRoute();

// ── State ─────────────────────────────────────────────────────────────────────
const conversations = ref<ChannelConversationListEntry[]>([]);
const selected = ref<ChannelConversationSnapshot | null>(null);
const selectedId = ref<string | null>(null);
const selectedMsgId = ref<string | null>(null);
const loading = ref(false);
const selectedLoading = ref(false);
const conversationActionLoading = ref(false);
const error = ref<string | null>(null);
const selectedError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const pendingOnly = ref(false);
const showExpiredOnly = ref(false);
const clientFilter = ref("");
const retryingMsgId = ref<string | null>(null);
const replyText = ref("");
const replyTarget = ref("");
const sendingReply = ref(false);
const sendReplyError = ref<string | null>(null);
const sentConfirmation = ref<string | null>(null);
const timelineEl = ref<HTMLElement | null>(null);
const replyInputEl = ref<HTMLTextAreaElement | null>(null);

let stopRegistryListener: (() => void) | null = null;
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Computed ──────────────────────────────────────────────────────────────────

const templates = MESSAGE_TEMPLATES;

const replyTargets = computed(() =>
  registryStore.agentList.filter(
    (a) =>
      a.entryType === "client" &&
      a.agentId !== registryStore.dashboardClientId &&
      a.clientInfo?.clientVersion !== "app-server-bridge",
  ),
);

const availableClients = computed(() => {
  const names = new Set<string>();
  for (const conv of conversations.value) {
    const name = conv.lastMessage.fromAgentName ?? conv.lastMessage.fromAgentId;
    if (name) names.add(name);
  }
  return [...names].sort();
});

const filteredConversations = computed(() => {
  return conversations.value.filter((conv) => {
    if (pendingOnly.value && !conv.pendingReply) return false;
    if (showExpiredOnly.value && !(conv.status === "expired" || conv.expired)) return false;
    if (clientFilter.value) {
      const name = conv.lastMessage.fromAgentName ?? conv.lastMessage.fromAgentId;
      if (name !== clientFilter.value) return false;
    }
    return true;
  });
});

const unifiedTimeline = computed(() => {
  if (!selected.value) return [];
  const messages = selected.value.messages.map((msg) => ({
    type: "message" as const,
    time: msg.createdAt,
    ...msg,
  }));
  const acks = selected.value.acknowledgements.map((ack) => ({
    type: "ack" as const,
    time: ack.timestamp,
    ...ack,
  }));
  return [...messages, ...acks].sort((a, b) => a.time - b.time);
});

// Map of messageId → latest ack state for quick lookup
const ackStateByMessage = computed((): Map<string, ChannelDeliveryState> => {
  const map = new Map<string, ChannelDeliveryState>();
  if (!selected.value) return map;
  for (const ack of selected.value.acknowledgements) {
    map.set(ack.messageId, ack.state);
  }
  return map;
});

const selectedMsg = computed((): ChannelMessagePayload | null => {
  if (!selectedMsgId.value || !selected.value) return null;
  return selected.value.messages.find((m) => m.messageId === selectedMsgId.value) ?? null;
});

const participants = computed((): string[] => {
  if (!selected.value) return [];
  const names = new Set<string>();
  for (const msg of selected.value.messages) {
    names.add(msg.fromAgentName ?? msg.fromAgentId);
    if (msg.toAgentId) names.add(msg.toAgentId);
  }
  return [...names];
});

const canReply = computed(
  () => !!selected.value && !!replyTarget.value && replyText.value.trim().length > 0 && !sendingReply.value,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function statusClass(status?: string): string {
  if (status === "pending") return "chip-violet";
  if (status === "expired" || status === "failed") return "chip-red";
  if (status === "answered") return "chip-emerald";
  return "chip-dim";
}

function msgDeliveryState(messageId: string): ChannelDeliveryState | undefined {
  return ackStateByMessage.value.get(messageId);
}

function isMessageFailed(messageId: string): boolean {
  return msgDeliveryState(messageId) === "failed";
}

function selectMessage(messageId: string) {
  selectedMsgId.value = selectedMsgId.value === messageId ? null : messageId;
}

function applyTemplate(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  if (!id) return;
  const t = templates.find((t) => t.id === id);
  if (t) {
    replyText.value = t.body;
    nextTick(() => replyInputEl.value?.focus());
  }
  (e.target as HTMLSelectElement).value = "";
}

function autoResizeReply() {
  if (!replyInputEl.value) return;
  replyInputEl.value.style.height = "auto";
  replyInputEl.value.style.height = Math.min(replyInputEl.value.scrollHeight, 120) + "px";
}

async function copyConversationId() {
  if (!selectedId.value) return;
  await navigator.clipboard.writeText(selectedId.value).catch(() => undefined);
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function reload() {
  loading.value = true;
  error.value = null;
  try {
    const all = await fetchChannelConversations({ pending: pendingOnly.value });
    conversations.value = showExpiredOnly.value
      ? all.filter((c) => c.status === "expired" || c.expired)
      : all;
    // Auto-select first if none is selected
    if (!selectedId.value && conversations.value.length > 0) {
      await selectConversation(conversations.value[0].conversationId);
    } else if (selectedId.value) {
      await refreshSelected();
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function selectConversation(conversationId: string) {
  selectedId.value = conversationId;
  selectedMsgId.value = null;
  selectedLoading.value = true;
  selectedError.value = null;
  try {
    selected.value = await fetchChannelConversation(conversationId);
    await nextTick();
    if (timelineEl.value) timelineEl.value.scrollTop = timelineEl.value.scrollHeight;
  } catch (err) {
    selectedError.value = err instanceof Error ? err.message : String(err);
  } finally {
    selectedLoading.value = false;
  }
}

async function refreshSelected() {
  if (!selectedId.value) return;
  try {
    selected.value = await fetchChannelConversation(selectedId.value);
  } catch {
    // Non-fatal: just leave the stale data
  }
}

function scheduleConversationRefresh(conversationId: string) {
  const existing = refreshTimers.get(conversationId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    refreshTimers.delete(conversationId);
    void refreshConversationInList(conversationId);
  }, 200);
  refreshTimers.set(conversationId, timer);
}

async function refreshConversationInList(conversationId: string) {
  try {
    const snapshot = await fetchChannelConversation(conversationId);
    if (selectedId.value === conversationId) {
      selected.value = snapshot;
      await nextTick();
      if (timelineEl.value) timelineEl.value.scrollTop = timelineEl.value.scrollHeight;
    }
    // Rebuild the summary entry in the list
    const lastMessage = snapshot.messages[snapshot.messages.length - 1];
    if (!lastMessage) return;
    const latestAckByMessage = new Map<string, ChannelAckPayload>();
    for (const ack of snapshot.acknowledgements) latestAckByMessage.set(ack.messageId, ack);
    const pendingMessages = snapshot.messages.filter((msg) => {
      if (!msg.expectsResponse) return false;
      const lastAck = latestAckByMessage.get(msg.messageId);
      return lastAck?.state !== "answered" && lastAck?.state !== "failed";
    });
    const expired = pendingMessages.some((msg) => msg.expiresAt && msg.expiresAt <= Date.now());
    const lastAckState = snapshot.acknowledgements.length > 0
      ? snapshot.acknowledgements[snapshot.acknowledgements.length - 1]!.state
      : undefined;
    let status: ChannelConversationListEntry["status"] = "active";
    if (expired) status = "expired";
    else if (pendingMessages.length > 0) status = "pending";
    else if (lastAckState === "failed") status = "failed";
    else if (lastAckState === "answered") status = "answered";

    const updatedEntry: ChannelConversationListEntry = {
      conversationId: snapshot.conversationId,
      lastMessage,
      pendingReply: pendingMessages.length > 0 && !expired,
      expired,
      lastAckState,
      pendingCount: pendingMessages.length,
      pendingMessageIds: pendingMessages.map((m) => m.messageId),
      status,
    };
    const next = conversations.value.filter((c) => c.conversationId !== conversationId);
    next.push(updatedEntry);
    next.sort((a, b) => b.lastMessage.createdAt - a.lastMessage.createdAt);
    conversations.value = next;
  } catch {
    conversations.value = conversations.value.filter((c) => c.conversationId !== conversationId);
    if (selectedId.value === conversationId) {
      selected.value = null;
      selectedId.value = null;
    }
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function handleSuppress() {
  if (!selectedId.value) return;
  conversationActionLoading.value = true;
  actionError.value = null;
  try {
    await suppressChannelConversation(selectedId.value);
    conversations.value = conversations.value.filter((c) => c.conversationId !== selectedId.value);
    selected.value = null;
    selectedId.value = null;
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    conversationActionLoading.value = false;
  }
}

async function handleRevive() {
  if (!selectedId.value) return;
  conversationActionLoading.value = true;
  actionError.value = null;
  try {
    await reviveChannelConversation(selectedId.value);
    await reload();
    if (selectedId.value) await selectConversation(selectedId.value);
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
  } finally {
    conversationActionLoading.value = false;
  }
}

async function retryMessage(conversationId: string, messageId: string) {
  retryingMsgId.value = messageId;
  try {
    await retryChannelMessage(conversationId, messageId);
    await refreshSelected();
  } catch {
    // Silently fail — the ack state will reflect the result
  } finally {
    retryingMsgId.value = null;
  }
}

async function sendReply() {
  if (!canReply.value || !selected.value) return;
  sendingReply.value = true;
  sendReplyError.value = null;
  sentConfirmation.value = null;

  const lastMsg = selected.value.messages.at(-1);
  const toAgentId = replyTarget.value;

  try {
    await createChannelMessage({
      conversationId: selected.value.conversationId,
      replyTo: lastMsg?.messageId,
      fromAgentId: dashboardChannelRuntime.clientId,
      fromAgentName: "Dashboard",
      toAgentId,
      kind: "chat",
      content: replyText.value.trim(),
      expectsResponse: true,
      requiresAck: true,
      expiresAt: Date.now() + 300_000,
      meta: { source: "inbox-reply" },
    });
    replyText.value = "";
    sentConfirmation.value = "Sent.";
    setTimeout(() => { sentConfirmation.value = null; }, 2500);
    await refreshSelected();
  } catch (err) {
    sendReplyError.value = err instanceof Error ? err.message : String(err);
  } finally {
    sendingReply.value = false;
  }
}

// ── WebSocket event handling ──────────────────────────────────────────────────

function handleRegistryEvent(msg: WsMessage) {
  if (msg.type === "channel.message" || msg.type === "channel.ack") {
    scheduleConversationRefresh(msg.data.conversationId);
    return;
  }
  if (msg.type === "channel.conversation.suppressed") {
    conversations.value = conversations.value.filter((c) => c.conversationId !== msg.data.conversationId);
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

// ── Watchers ──────────────────────────────────────────────────────────────────

watch([pendingOnly, showExpiredOnly, clientFilter], () => {
  void reload();
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  stopRegistryListener = dashboardChannelRuntime.on("registry", handleRegistryEvent);
  await reload();
  // Auto-select conversation from ?conv= query param (e.g. linked from Plans view)
  const convId = route.query.conv as string | undefined;
  if (convId && convId !== selectedId.value) {
    await selectConversation(convId);
  }
});

onUnmounted(() => {
  stopRegistryListener?.();
  stopRegistryListener = null;
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
});
</script>

<style scoped>
.inbox-grid {
  display: grid;
  grid-template-columns: 26% 1fr 26%;
  gap: 0;
  flex: 1;
  min-height: 0;
}

.inbox-col-threads,
.inbox-col-transcript,
.inbox-col-actions {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.inbox-toolbar {
  flex-wrap: wrap;
  gap: 8px;
}

.channel-scope-field {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.channel-scope-text {
  font-size: 0.88rem;
  color: var(--text-dim);
}

.client-filter-wrap {
  flex: 1;
  min-width: 80px;
}

/* Thread list cards */
.conversation-item__token--spaced {
  margin-top: 6px;
}

.conversation-item__preview--singleline {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.8rem;
  opacity: 0.7;
  margin-top: 4px;
}

/* Transcript header */
.transcript-id {
  display: flex;
  align-items: center;
  gap: 4px;
}

.copy-btn {
  background: none;
  border: none;
  padding: 0 4px;
  cursor: pointer;
  color: var(--text-dim);
  font-size: 0.75rem;
  line-height: 1;
  transition: color 0.15s;
}

.copy-btn:hover {
  color: var(--text);
}

/* Participants */
.conv-participants {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.conv-participant-label {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  color: var(--text-ghost);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.conv-participant-chip {
  font-size: 0.68rem;
}

/* Timeline */
.conv-timeline-wrap {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.conv-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.conv-msg-card {
  background: rgba(221, 186, 154, 0.07);
  border: 1px solid rgba(221, 186, 154, 0.14);
  border-radius: 8px;
  padding: 10px 14px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.conv-msg-card:hover,
.conv-msg-card--selected {
  border-color: rgba(221, 186, 154, 0.35);
}

.conv-msg-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.conv-msg-from {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--text-ink);
  font-weight: 600;
}

.conv-msg-kind {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  padding: 2px 7px;
  background: rgba(185, 130, 255, 0.18);
  color: #7c3aed;
  border-radius: 4px;
  border: 1px solid rgba(185, 130, 255, 0.3);
}

.conv-msg-time {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  color: rgba(39, 29, 25, 0.45);
  margin-left: auto;
}

.conv-msg-body {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-ink);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.msg-delivery-progress {
  margin-top: 8px;
}

.retry-btn {
  font-size: 0.65rem;
  padding: 1px 6px;
}

.btn-xs {
  font-size: 0.65rem;
  padding: 2px 7px;
}

/* ACK pills */
.conv-ack-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: rgba(32, 24, 20, 0.5);
  border-left: 2px solid rgba(221, 186, 154, 0.15);
  margin-left: 14px;
  border-radius: 0 4px 4px 0;
}

.conv-ack-state {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
}

.ack-answered {
  background: rgba(100, 220, 140, 0.15);
  color: var(--emerald);
  border: 1px solid rgba(100, 220, 140, 0.25);
}

.ack-failed {
  background: rgba(255, 90, 90, 0.15);
  color: var(--red);
  border: 1px solid rgba(255, 90, 90, 0.25);
}

.ack-displayed_to_client {
  background: rgba(100, 200, 255, 0.12);
  color: var(--cyan, #7ec8e3);
  border: 1px solid rgba(100, 200, 255, 0.2);
}

.ack-queued,
.ack-delivered_to_bridge {
  background: rgba(255, 197, 108, 0.12);
  color: var(--amber);
  border: 1px solid rgba(255, 197, 108, 0.2);
}

.conv-ack-actor {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  color: var(--text-dim);
}

.conv-ack-time {
  font-family: var(--font-mono);
  font-size: 0.58rem;
  color: var(--text-dim);
  margin-left: auto;
  opacity: 0.7;
}

/* Actions column */
.actions-body {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 14px;
}

.actions-section {
  border-bottom: 1px solid var(--border-dim);
  padding-bottom: 16px;
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.actions-section:last-child {
  border-bottom: none;
}

.actions-section-title {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-ghost);
}

.actions-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Reply composer */
.template-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.reply-compose {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reply-textarea {
  width: 100%;
  min-height: 64px;
  max-height: 160px;
  resize: none;
  background: rgba(32, 24, 20, 0.5);
  border: 1px solid var(--border-mid);
  border-radius: 8px;
  color: var(--text);
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.5;
  transition: border-color 0.15s;
}

.reply-textarea:focus {
  outline: none;
  border-color: var(--border-strong);
}

.reply-compose-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.reply-compose-hint {
  font-size: 0.62rem;
  color: var(--text-ghost);
}

.sent-confirmation {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--emerald);
}

/* Message detail table */
.msg-detail-table {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.msg-detail-row {
  display: flex;
  gap: 10px;
  font-size: 0.72rem;
}

.msg-detail-key {
  font-family: var(--font-mono);
  color: var(--text-ghost);
  min-width: 48px;
}

.msg-detail-val {
  font-family: var(--font-mono);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.expired-label {
  color: var(--red);
}

/* Inline link */
.inline-link {
  color: var(--violet);
  text-decoration: underline;
}

/* Thread list light-bg overrides */
.conversation-list .conversation-item__sender {
  color: var(--text);
}

.conversation-list .conversation-item__token {
  color: rgba(255, 247, 237, 0.46);
}

.sig-select--sm {
  font-size: 0.78rem;
  padding: 3px 24px 3px 8px;
}
</style>
