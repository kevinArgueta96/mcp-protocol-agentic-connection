import type { ChannelAck, ChannelDeliveryState, ChannelMessage } from "../types/messages.js";

export interface ConversationSessionState {
  conversationId: string;
  messageIds: string[];
  pendingMessageIds: string[];
  lastMessageId?: string;
  lastAckState?: ChannelDeliveryState;
  awaitingReply: boolean;
}

export interface ListedConversationSession extends ConversationSessionState {
  lastUpdatedAt?: number;
}

export interface ResolvedReplyContext {
  conversationId: string;
  replyTo: string;
  toAgentId: string;
  taskId?: string;
  message: ChannelMessage;
}

export interface ConversationSessionStoreOptions {
  recentMessageTtlMs?: number;
}

interface StoredConversationSession {
  state: ConversationSessionState;
  messageTimers: Map<string, NodeJS.Timeout>;
}

export class ConversationSessionStore {
  private readonly recentMessageTtlMs: number;
  private readonly messages = new Map<string, ChannelMessage>();
  private readonly conversations = new Map<string, StoredConversationSession>();
  private readonly deletedConversationIds = new Set<string>();

  constructor(options: ConversationSessionStoreOptions = {}) {
    this.recentMessageTtlMs = options.recentMessageTtlMs ?? 3_600_000;
  }

  trackMessage(message: ChannelMessage): ConversationSessionState | undefined {
    // Auto-revive: a new inbound message overrides local suppression, consistent with the
    // registry which revives server-side before creating the message, and with sendMessage()
    // which calls reviveConversation() on the sender side before posting.
    if (this.deletedConversationIds.has(message.conversationId)) {
      this.deletedConversationIds.delete(message.conversationId);
    }
    this.messages.set(message.messageId, message);

    const session = this.ensureConversation(message.conversationId);
    if (!session.state.messageIds.includes(message.messageId)) {
      session.state.messageIds.push(message.messageId);
    }

    session.state.lastMessageId = message.messageId;
    // A message is treated as needing a response UNLESS the sender explicitly
    // opted into fire-and-forget by setting `expectsResponse: false`. Without
    // this default, callers that simply omit the field (the common case for
    // clients that just want to deliver a chat through `message_client_session`)
    // would never surface the message in `channel_inbox(pendingOnly=true)` on
    // the receiver — leaving Codex/Gemini unable to discover the inbound work
    // via polling. The bridge daemon's turn injection is independent of this
    // flag, so we never hide an inbound message from the agent loop.
    const treatsAsPending = message.expectsResponse !== false;
    if (treatsAsPending) {
      this.addPendingMessageId(session.state, message.messageId);
      // Reset stale terminal ack state so waitForAcknowledgement() doesn't return
      // the previous exchange's "answered"/"failed" as if this new message is done.
      if (
        session.state.lastAckState === "answered" ||
        session.state.lastAckState === "failed"
      ) {
        session.state.lastAckState = undefined;
      }
    }
    if (message.replyTo) {
      this.removePendingMessageId(session.state, message.replyTo);
    }
    session.state.awaitingReply = session.state.pendingMessageIds.length > 0;

    const priorTimer = session.messageTimers.get(message.messageId);
    if (priorTimer) clearTimeout(priorTimer);
    const timer = setTimeout(() => {
      this.messages.delete(message.messageId);
      session.messageTimers.delete(message.messageId);
    }, this.recentMessageTtlMs);
    session.messageTimers.set(message.messageId, timer);
    return {
      ...session.state,
      messageIds: [...session.state.messageIds],
      pendingMessageIds: [...session.state.pendingMessageIds],
    };
  }

  trackAck(ack: ChannelAck): ConversationSessionState | undefined {
    if (this.deletedConversationIds.has(ack.conversationId)) {
      return undefined;
    }
    const session = this.ensureConversation(ack.conversationId);
    session.state.lastAckState = ack.state;

    if (ack.state === "answered" || ack.state === "failed") {
      this.removePendingMessageId(session.state, ack.messageId);
    }
    session.state.awaitingReply = session.state.pendingMessageIds.length > 0;
    return {
      ...session.state,
      messageIds: [...session.state.messageIds],
      pendingMessageIds: [...session.state.pendingMessageIds],
    };
  }

  getMessage(messageId: string): ChannelMessage | undefined {
    return this.messages.get(messageId);
  }

  getConversation(conversationId: string): ConversationSessionState | undefined {
    if (this.deletedConversationIds.has(conversationId)) return undefined;
    const state = this.conversations.get(conversationId)?.state;
    return state
      ? {
          ...state,
          messageIds: [...state.messageIds],
          pendingMessageIds: [...state.pendingMessageIds],
        }
      : undefined;
  }

  listMessages(conversationId: string): ChannelMessage[] {
    if (this.deletedConversationIds.has(conversationId)) return [];
    const session = this.conversations.get(conversationId);
    if (!session) return [];
    return session.state.messageIds
      .map((messageId) => this.messages.get(messageId))
      .filter((message): message is ChannelMessage => Boolean(message));
  }

  listPendingMessages(conversationId: string): ChannelMessage[] {
    if (this.deletedConversationIds.has(conversationId)) return [];
    const session = this.conversations.get(conversationId);
    if (!session) return [];
    return session.state.pendingMessageIds
      .map((messageId) => this.messages.get(messageId))
      .filter((message): message is ChannelMessage => Boolean(message));
  }

  resolveReplyContext(input: {
    replyTo?: string;
    conversationId?: string;
    toAgentId?: string;
    taskId?: string;
  }): ResolvedReplyContext | undefined {
    if (input.replyTo) {
      const message = this.messages.get(input.replyTo);
      if (!message) return undefined;
      if (this.deletedConversationIds.has(message.conversationId)) return undefined;
      return {
        conversationId: input.conversationId ?? message.conversationId,
        replyTo: message.messageId,
        toAgentId: input.toAgentId ?? message.fromAgentId,
        taskId: input.taskId ?? message.taskId,
        message,
      };
    }

    if (!input.conversationId) return undefined;
    if (this.deletedConversationIds.has(input.conversationId)) return undefined;
    const session = this.conversations.get(input.conversationId);
    if (!session?.state.lastMessageId) return undefined;

    const message = this.messages.get(session.state.lastMessageId);
    if (!message) return undefined;

    return {
      conversationId: input.conversationId,
      replyTo: message.messageId,
      toAgentId: input.toAgentId ?? message.fromAgentId,
      taskId: input.taskId ?? message.taskId,
      message,
    };
  }

  listPendingConversations(): ListedConversationSession[] {
    return this.listConversations().filter((state) => state.awaitingReply);
  }

  listConversations(limit?: number): ListedConversationSession[] {
    const conversations = Array.from(this.conversations.values())
      .map((session) => {
        const baseState = session.state;
        const lastUpdatedAt = baseState.lastMessageId
          ? this.messages.get(baseState.lastMessageId)?.createdAt
          : undefined;
        return {
          ...baseState,
          messageIds: [...baseState.messageIds],
          pendingMessageIds: [...baseState.pendingMessageIds],
          lastUpdatedAt,
        };
      })
      .sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0));

    return typeof limit === "number" ? conversations.slice(0, limit) : conversations;
  }

  deleteConversation(conversationId: string): boolean {
    const session = this.conversations.get(conversationId);
    const hadConversation = Boolean(session) || this.deletedConversationIds.has(conversationId);
    if (session) {
      for (const messageId of session.state.messageIds) {
        const timer = session.messageTimers.get(messageId);
        if (timer) clearTimeout(timer);
        session.messageTimers.delete(messageId);
        this.messages.delete(messageId);
      }

      this.conversations.delete(conversationId);
    }
    this.deletedConversationIds.add(conversationId);
    return hadConversation;
  }

  reviveConversation(conversationId: string): void {
    this.deletedConversationIds.delete(conversationId);
  }

  clear(): void {
    for (const session of this.conversations.values()) {
      for (const timer of session.messageTimers.values()) {
        clearTimeout(timer);
      }
    }
    this.messages.clear();
    this.conversations.clear();
    this.deletedConversationIds.clear();
  }

  private ensureConversation(conversationId: string): StoredConversationSession {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;

    const created: StoredConversationSession = {
      state: {
        conversationId,
        messageIds: [],
        pendingMessageIds: [],
        awaitingReply: false,
      },
      messageTimers: new Map(),
    };
    this.conversations.set(conversationId, created);
    return created;
  }

  private addPendingMessageId(state: ConversationSessionState, messageId: string): void {
    if (!state.pendingMessageIds.includes(messageId)) {
      state.pendingMessageIds.push(messageId);
    }
  }

  private removePendingMessageId(state: ConversationSessionState, messageId: string): void {
    state.pendingMessageIds = state.pendingMessageIds.filter((id) => id !== messageId);
  }
}
