import type { ChannelDeliveryState, ChannelMessage } from "../types/messages.js";
import { ChannelClientRuntime, type ChannelReplyInput, type ChannelReplyResult } from "./channel-client-runtime.js";
import type { ConversationSessionState, ListedConversationSession } from "./conversation-session-store.js";

export type ConversationStatus = "pending" | "answered" | "failed" | "expired" | "active";

export interface ConversationSnapshot {
  conversation: ConversationSessionState;
  messages: ChannelMessage[];
  pendingMessages: ChannelMessage[];
  status: ConversationStatus;
  lastUpdatedAt?: number;
  lastMessage?: ChannelMessage;
}

export interface StartConversationInput {
  conversationId?: string;
  toAgentId: string;
  message: string;
  taskId?: string;
  kind?: ChannelMessage["kind"];
  meta?: Record<string, unknown>;
  expectsResponse?: boolean;
  requiresAck?: boolean;
  expiresAt?: number;
}

export interface ReplyAndAcknowledgeInput extends ChannelReplyInput {
  acknowledgementState?: Extract<ChannelDeliveryState, "answered" | "failed">;
  acknowledgementDetail?: string;
}

export class ConversationService {
  constructor(private readonly runtime: ChannelClientRuntime) {}

  getSnapshot(conversationId: string): ConversationSnapshot | undefined {
    const conversation = this.runtime.getConversation(conversationId);
    if (!conversation) return undefined;
    const messages = this.runtime.listConversationMessages(conversationId);
    return this.buildSnapshot(conversation, messages, this.runtime.listPendingConversationMessages(conversationId));
  }

  listPendingSnapshots(): ConversationSnapshot[] {
    return this.runtime
      .listPendingConversations()
      .map((conversation) =>
        this.buildSnapshot(
          conversation,
          this.runtime.listConversationMessages(conversation.conversationId),
          this.runtime.listPendingConversationMessages(conversation.conversationId),
        )
      )
      .filter((snapshot) => snapshot.status === "pending");
  }

  listUnsurfacedSnapshots(surfacedMessageIds: ReadonlySet<string>): ConversationSnapshot[] {
    return this.runtime
      .listConversations()
      .map((conversation) =>
        this.buildSnapshot(
          conversation,
          this.runtime.listConversationMessages(conversation.conversationId),
          this.runtime.listPendingConversationMessages(conversation.conversationId),
        )
      )
      .filter((snapshot) => snapshot.messages.some((m) => !surfacedMessageIds.has(m.messageId)));
  }

  listExpiredSnapshots(limit = 10): ConversationSnapshot[] {
    return this.runtime
      .listConversations()
      .map((conversation) =>
        this.buildSnapshot(
          conversation,
          this.runtime.listConversationMessages(conversation.conversationId),
          this.runtime.listPendingConversationMessages(conversation.conversationId),
        )
      )
      .filter((snapshot) => snapshot.status === "expired")
      .slice(0, limit);
  }

  listRecentSnapshots(limit = 10): ConversationSnapshot[] {
    return this.runtime.listConversations(limit).map((conversation) =>
      this.buildSnapshot(
        conversation,
        this.runtime.listConversationMessages(conversation.conversationId),
        this.runtime.listPendingConversationMessages(conversation.conversationId),
      )
    );
  }

  async markExpiredAsFailed(limit = 10): Promise<ConversationSnapshot[]> {
    const expired = this.listExpiredSnapshots(limit);

    for (const snapshot of expired) {
      for (const expiredMessage of snapshot.pendingMessages.filter(
        (message) => message.expiresAt && message.expiresAt <= Date.now(),
      )) {
        await this.runtime.acknowledgeMessage({
          conversationId: snapshot.conversation.conversationId,
          messageId: expiredMessage.messageId,
          state: "failed",
          actorType: "client",
          detail: "Conversation expired locally before receiving a reply",
        });
      }
    }

    return expired
      .map((snapshot) => this.getSnapshot(snapshot.conversation.conversationId))
      .filter((snapshot): snapshot is ConversationSnapshot => Boolean(snapshot));
  }

  deleteConversation(conversationId: string): boolean {
    return this.runtime.deleteConversation(conversationId);
  }

  async startConversation(input: StartConversationInput): Promise<ConversationSnapshot> {
    const message = await this.runtime.sendMessage({
      conversationId: input.conversationId,
      toAgentId: input.toAgentId,
      taskId: input.taskId,
      kind: input.kind ?? "chat",
      content: input.message,
      meta: input.meta,
      expectsResponse: input.expectsResponse,
      requiresAck: input.requiresAck,
      expiresAt: input.expiresAt,
    });

    return this.requireSnapshot(message.conversationId);
  }

  async replyAndAcknowledge(input: ReplyAndAcknowledgeInput): Promise<{
    reply: ChannelReplyResult;
    snapshot: ConversationSnapshot;
  }> {
    const reply = await this.runtime.reply(input);

    if (input.acknowledgementState) {
      const acknowledgedMessageId = reply.resolvedContext?.replyTo ?? input.replyTo;
      if (!acknowledgedMessageId) {
        throw new Error("Reply acknowledgement requires a resolved reply target");
      }
      await this.runtime.acknowledgeMessage({
        conversationId: reply.message.conversationId,
        messageId: acknowledgedMessageId,
        state: input.acknowledgementState,
        actorType: "client",
        detail: input.acknowledgementDetail,
      });
    }

    return {
      reply,
      snapshot: this.requireSnapshot(reply.message.conversationId),
    };
  }

  async waitForAcknowledgement(
    conversationId: string,
    messageId: string,
    options?: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      states?: ChannelDeliveryState[];
    },
  ): Promise<ChannelDeliveryState | undefined> {
    const timeoutMs = options?.timeoutMs ?? 1_500;
    const pollIntervalMs = options?.pollIntervalMs ?? 150;
    const states = options?.states ?? ["delivered_to_bridge", "displayed_to_client", "answered", "failed"];
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const snapshot = this.getSnapshot(conversationId);
      const state = snapshot?.conversation.lastAckState;
      if (state && states.includes(state)) {
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return this.getSnapshot(conversationId)?.conversation.lastAckState;
  }

  private requireSnapshot(conversationId: string): ConversationSnapshot {
    const snapshot = this.getSnapshot(conversationId);
    if (!snapshot) {
      throw new Error(`Conversation snapshot not found for ${conversationId}`);
    }
    return snapshot;
  }

  private buildSnapshot(
    conversation: ConversationSessionState | ListedConversationSession,
    messages: ChannelMessage[],
    pendingMessages: ChannelMessage[],
  ): ConversationSnapshot {
    const lastMessage = messages[messages.length - 1];
    const listedConversation = conversation as ListedConversationSession;
    return {
      conversation,
      messages,
      pendingMessages,
      status: this.resolveStatus(conversation, pendingMessages),
      lastUpdatedAt: listedConversation.lastUpdatedAt ?? lastMessage?.createdAt,
      lastMessage,
    };
  }

  private resolveStatus(conversation: ConversationSessionState, pendingMessages: ChannelMessage[]): ConversationStatus {
    const now = Date.now();
    const hasExpiredPending = pendingMessages.some((message) => message.expiresAt && message.expiresAt <= now);
    const hasPending = pendingMessages.length > 0;

    if (hasExpiredPending) return "expired";
    if (hasPending || conversation.awaitingReply) return "pending";
    if (conversation.lastAckState === "failed") return "failed";
    if (conversation.lastAckState === "answered") return "answered";
    return "active";
  }
}
