import { WebSocket } from "ws";
import type { AgentRegistration, ChannelAck, ChannelMessage } from "../types/messages.js";

const DEFAULT_REGISTRY_URL = "http://localhost:4999";

export interface ChannelTransportOptions {
  registryUrl?: string;
}

export interface ConnectWebSocketOptions {
  agentId?: string;
  onMessage: (raw: string) => void;
  onOpen?: (ws: WebSocket) => void;
  onClose?: (code?: number, reason?: string) => void;
  onError?: () => void;
}

export class ChannelTransport {
  private readonly registryUrl: string;

  constructor(options: ChannelTransportOptions = {}) {
    this.registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
  }

  getRegistryUrl(): string {
    return this.registryUrl;
  }

  getRegistryWsUrl(): string {
    return this.registryUrl.replace(/^http/, "ws") + "/ws";
  }

  async registerClient(registration: AgentRegistration): Promise<void> {
    const response = await fetch(`${this.registryUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    });

    if (!response.ok) {
      throw new Error(`Client registration failed: ${response.status}`);
    }
  }

  async deregisterClient(agentId: string): Promise<void> {
    const response = await fetch(`${this.registryUrl}/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(`Client deregistration failed: ${response.status}`);
    }
  }

  async sendHeartbeat(agentId: string): Promise<void> {
    const response = await fetch(`${this.registryUrl}/agents/${encodeURIComponent(agentId)}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId,
        timestamp: Date.now(),
        status: "alive",
      }),
    });

    if (!response.ok) {
      throw new Error(`Heartbeat failed: ${response.status}`);
    }
  }

  async postChannelMessage(message: {
    conversationId?: string;
    messageId?: string;
    replyTo?: string;
    fromAgentId: string;
    fromAgentName?: string;
    toAgentId?: string;
    taskId?: string;
    kind: ChannelMessage["kind"];
    content: string;
    meta?: Record<string, unknown>;
    createdAt?: number;
    expiresAt?: number;
    attemptCount?: number;
    requiresAck?: boolean;
    expectsResponse?: boolean;
  }): Promise<ChannelMessage> {
    const response = await fetch(`${this.registryUrl}/channel/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Channel message failed: ${response.status}`);
    }

    return response.json() as Promise<ChannelMessage>;
  }

  async postChannelAck(ack: Omit<ChannelAck, "timestamp"> & { timestamp?: number }): Promise<void> {
    const response = await fetch(`${this.registryUrl}/channel/acks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...ack,
        timestamp: ack.timestamp ?? Date.now(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Channel ack failed: ${response.status}`);
    }
  }

  connectWebSocket(options: ConnectWebSocketOptions): WebSocket {
    const ws = new WebSocket(this.getRegistryWsUrl());

    ws.on("open", () => {
      if (options.agentId) {
        ws.send(JSON.stringify({ type: "identify", agentId: options.agentId }));
      }
      options.onOpen?.(ws);
    });

    ws.on("message", (raw) => {
      options.onMessage(raw.toString());
    });

    ws.on("close", (code, reason) => {
      options.onClose?.(code, typeof reason === "string" ? reason : reason?.toString());
    });

    ws.on("error", () => {
      options.onError?.();
    });

    return ws;
  }

  identifyWebSocket(ws: WebSocket, agentId: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "identify", agentId }));
  }
}
