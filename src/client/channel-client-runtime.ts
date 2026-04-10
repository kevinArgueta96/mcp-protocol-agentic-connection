import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { ChannelTransport } from "./channel-transport.js";
import { ConversationSessionStore, type ConversationSessionState, type ListedConversationSession, type ResolvedReplyContext } from "./conversation-session-store.js";
import type { AgentMessage, AgentRegistration, ChannelAck, ChannelDeliveryState, ChannelMessage } from "../types/messages.js";

export interface ChannelClientRuntimeOptions {
  transport: ChannelTransport;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  recentMessageTtlMs?: number;
}

export interface ChannelReplyInput {
  agentId?: string;
  conversationId?: string;
  replyTo?: string;
  taskId?: string;
  kind?: ChannelMessage["kind"];
  message: string;
  meta?: Record<string, unknown>;
  requiresAck?: boolean;
  expectsResponse?: boolean;
  expiresAt?: number;
}

export interface ChannelReplyResult {
  message: ChannelMessage;
  resolvedContext?: ResolvedReplyContext;
}

export interface ChannelDeliveryAckInput {
  messageId: string;
  state: ChannelDeliveryState;
  conversationId?: string;
  actorId?: string;
  actorType?: ChannelAck["actorType"];
  detail?: string;
}

interface LegacyNotifyPayload {
  agentId?: string;
  agentName?: string;
  content: string;
  meta?: Record<string, unknown>;
  conversationId?: string;
  messageId?: string;
}

interface RuntimeEvents {
  "ws.open": () => void;
  "ws.close": () => void;
  "registry.event": (event: unknown) => void;
  "channel.message": (message: ChannelMessage) => void;
  "channel.ack": (ack: ChannelAck) => void;
  "conversation.updated": (state: ConversationSessionState) => void;
  "agent.message": (message: AgentMessage) => void;
  "legacy.notify": (payload: LegacyNotifyPayload) => void;
}

export class ChannelClientRuntime {
  private readonly transport: ChannelTransport;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly emitter = new EventEmitter();
  private readonly conversationStore: ConversationSessionStore;

  private readonly emittedMessageIds = new Set<string>();
  private readonly emittedMessageTtlMs: number;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private destroyed = false;
  private currentAgentId: string | null = null;
  private activeRegistration: AgentRegistration | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: ChannelClientRuntimeOptions) {
    this.transport = options.transport;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.emittedMessageTtlMs = options.recentMessageTtlMs ?? 3_600_000;
    this.conversationStore = new ConversationSessionStore({
      recentMessageTtlMs: options.recentMessageTtlMs,
    });
  }

  on<K extends keyof RuntimeEvents>(event: K, listener: RuntimeEvents[K]): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  connect(): void {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    // Close any lingering socket (CLOSING state) to prevent phantom connections
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    try {
      const ws = this.transport.connectWebSocket({
        agentId: this.currentAgentId ?? undefined,
        onOpen: () => {
          if (this.ws !== ws) return;
          this.emitter.emit("ws.open");
        },
        onMessage: (raw) => {
          if (this.ws !== ws) return;
          this.handleRawMessage(raw);
        },
        onClose: (code) => {
          if (this.ws !== ws) return;
          this.ws = null;
          this.emitter.emit("ws.close");
          if (code === 4001) {
            console.error(`[ChannelRuntime] WS superseded (4001), stopping reconnect for ${this.currentAgentId}`);
            return;
          }
          this.scheduleReconnect();
        },
        onError: () => {
          if (this.ws !== ws) return;
          this.ws = null;
        },
      });
      this.ws = ws;
    } catch {
      this.scheduleReconnect();
    }
  }

  getWebSocket(): WebSocket | null {
    return this.ws;
  }

  getCurrentAgentId(): string | null {
    return this.currentAgentId;
  }

  getRecentMessage(messageId: string): ChannelMessage | undefined {
    return this.conversationStore.getMessage(messageId);
  }

  getConversation(conversationId: string): ConversationSessionState | undefined {
    return this.conversationStore.getConversation(conversationId);
  }

  listPendingConversations(): ListedConversationSession[] {
    return this.conversationStore.listPendingConversations();
  }

  listConversations(limit?: number): ListedConversationSession[] {
    return this.conversationStore.listConversations(limit);
  }

  listConversationMessages(conversationId: string): ChannelMessage[] {
    return this.conversationStore.listMessages(conversationId);
  }

  listPendingConversationMessages(conversationId: string): ChannelMessage[] {
    return this.conversationStore.listPendingMessages(conversationId);
  }

  deleteConversation(conversationId: string): boolean {
    return this.conversationStore.deleteConversation(conversationId);
  }

  /** Seed the local conversation store with messages from the registry HTTP snapshot.
   *  Call this once after client activation to surface pre-existing conversations. */
  seedFromSnapshot(messages: import("../types/messages.js").ChannelMessage[]): void {
    for (const message of messages) {
      this.conversationStore.trackMessage(message);
    }
  }

  resolveReplyContext(input: {
    replyTo?: string;
    conversationId?: string;
    toAgentId?: string;
    taskId?: string;
  }): ResolvedReplyContext | undefined {
    return this.conversationStore.resolveReplyContext(input);
  }

  async activateClient(registration: AgentRegistration, heartbeatMs = 30_000): Promise<void> {
    if (this.currentAgentId === registration.agentId && this.activeRegistration) {
      return;
    }
    this.activeRegistration = registration;
    this.currentAgentId = registration.agentId;
    await this.transport.registerClient(registration);
    this.identify();
    this.startHeartbeat(heartbeatMs);
  }

  async deactivateClient(): Promise<void> {
    this.stopHeartbeat();
    const agentId = this.currentAgentId;
    this.activeRegistration = null;
    this.currentAgentId = null;
    if (agentId) {
      try {
        await this.transport.deregisterClient(agentId);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  identify(): void {
    if (!this.ws || !this.currentAgentId) return;
    this.transport.identifyWebSocket(this.ws, this.currentAgentId);
  }

  async sendMessage(message: {
    conversationId?: string;
    messageId?: string;
    replyTo?: string;
    fromAgentName?: string;
    toAgentId?: string;
    taskId?: string;
    kind?: ChannelMessage["kind"];
    content: string;
    meta?: Record<string, unknown>;
    expectsResponse?: boolean;
    requiresAck?: boolean;
    expiresAt?: number;
  }): Promise<ChannelMessage> {
    if (!this.currentAgentId) {
      throw new Error("Channel client is not activated");
    }

    if (message.conversationId) {
      this.conversationStore.reviveConversation(message.conversationId);
    }

    const created = await this.transport.postChannelMessage({
      conversationId: message.conversationId,
      messageId: message.messageId,
      replyTo: message.replyTo,
      fromAgentId: this.currentAgentId,
      fromAgentName: message.fromAgentName ?? this.activeRegistration?.projectName,
      toAgentId: message.toAgentId,
      taskId: message.taskId,
      kind: message.kind ?? "chat",
      content: message.content,
      meta: message.meta,
      expectsResponse: message.expectsResponse,
      requiresAck: message.requiresAck,
      expiresAt: message.expiresAt,
    });

    const updatedState = this.conversationStore.trackMessage(created);
    if (updatedState) {
      this.emitConversationUpdate(updatedState);
    }
    return created;
  }

  async reply(input: ChannelReplyInput): Promise<ChannelReplyResult> {
    const resolvedContext = this.resolveReplyContext({
      replyTo: input.replyTo,
      conversationId: input.conversationId,
      toAgentId: input.agentId,
      taskId: input.taskId,
    });

    const toAgentId = input.agentId ?? resolvedContext?.toAgentId;
    if (!toAgentId) {
      throw new Error("Reply requires either agentId or a known conversation/replyTo context");
    }

    const message = await this.sendMessage({
      conversationId: input.conversationId ?? resolvedContext?.conversationId,
      replyTo: input.replyTo ?? resolvedContext?.replyTo,
      fromAgentName: this.activeRegistration?.projectName,
      toAgentId,
      taskId: input.taskId ?? resolvedContext?.taskId,
      kind: input.kind ?? "chat",
      content: input.message,
      meta: input.meta,
      requiresAck: input.requiresAck,
      expectsResponse: input.expectsResponse,
      expiresAt: input.expiresAt,
    });

    return { message, resolvedContext };
  }

  async sendAck(ack: Omit<ChannelAck, "timestamp" | "actorId"> & { actorId?: string; timestamp?: number }): Promise<void> {
    if (!this.currentAgentId && !ack.actorId) {
      throw new Error("Channel client is not activated");
    }

    await this.transport.postChannelAck({
      ...ack,
      actorId: ack.actorId ?? this.currentAgentId ?? "unknown-client",
      timestamp: ack.timestamp,
    });
  }

  async acknowledgeMessage(input: ChannelDeliveryAckInput): Promise<void> {
    const knownMessage = this.conversationStore.getMessage(input.messageId);
    const conversationId = input.conversationId ?? knownMessage?.conversationId;
    if (!conversationId) {
      throw new Error("Acknowledge requires conversationId or a known messageId");
    }

    const ack: ChannelAck = {
      conversationId,
      messageId: input.messageId,
      state: input.state,
      actorId: input.actorId ?? this.currentAgentId ?? "unknown-client",
      actorType: input.actorType ?? "client",
      timestamp: Date.now(),
      detail: input.detail,
    };

    await this.transport.postChannelAck(ack);
    const updatedState = this.conversationStore.trackAck(ack);
    if (updatedState) {
      this.emitConversationUpdate(updatedState);
    }
    this.emitter.emit("channel.ack", ack);
  }

  async destroyRuntime(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.deactivateClient();
    this.ws?.close();
    this.ws = null;
    this.conversationStore.clear();
  }

  private startHeartbeat(heartbeatMs: number): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      if (!this.currentAgentId) return;
      try {
        await this.transport.sendHeartbeat(this.currentAgentId);
      } catch {
        if (this.activeRegistration) {
          try {
            await this.transport.registerClient(this.activeRegistration);
            // Re-identify on existing WS so agentWsMap is updated in registry
            this.identify();
          } catch {
            // Ignore; next heartbeat/reconnect will try again.
          }
        }
      }
    }, heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    const baseDelay = this.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts - 1);
    const jitter = Math.random() * 1_000;
    const delay = Math.min(baseDelay + jitter, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleRawMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    this.emitter.emit("registry.event", parsed);
    if (!parsed || typeof parsed !== "object") return;

    const event = parsed as { type?: string; data?: unknown };
    if (event.type === "identified") {
      this.reconnectAttempts = 0;
      return;
    }

    if (event.type === "channel.message" && event.data) {
      const message = event.data as ChannelMessage;
      if (this.emittedMessageIds.has(message.messageId)) return;
      const updatedState = this.conversationStore.trackMessage(message);
      if (!updatedState) return;
      this.emittedMessageIds.add(message.messageId);
      setTimeout(() => this.emittedMessageIds.delete(message.messageId), this.emittedMessageTtlMs);
      this.emitConversationUpdate(updatedState);
      this.emitter.emit("channel.message", message);
      return;
    }

    if (event.type === "channel.ack" && event.data) {
      const ack = event.data as ChannelAck;
      const updatedState = this.conversationStore.trackAck(ack);
      if (!updatedState) return;
      this.emitConversationUpdate(updatedState);
      this.emitter.emit("channel.ack", ack);
      return;
    }

    if (event.type === "channel.conversation.suppressed" && event.data) {
      const conversationId = (event.data as { conversationId?: string }).conversationId;
      if (conversationId) {
        this.conversationStore.deleteConversation(conversationId);
      }
      return;
    }

    if (event.type === "channel.conversation.revived" && event.data) {
      const conversationId = (event.data as { conversationId?: string }).conversationId;
      if (conversationId) {
        this.conversationStore.reviveConversation(conversationId);
      }
      return;
    }

    if (event.type === "agent.message" && event.data) {
      this.emitter.emit("agent.message", event.data as AgentMessage);
      return;
    }

    if (event.type === "claude.notify" && event.data) {
      this.emitter.emit("legacy.notify", event.data as LegacyNotifyPayload);
    }
  }

  private emitConversationUpdate(state: ConversationSessionState): void {
    this.emitter.emit("conversation.updated", state);
  }
}
