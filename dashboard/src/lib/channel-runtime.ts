import type { DashboardClientProfile } from "@/lib/dashboard-client-profile";
import { DefaultDashboardClientProfileResolver } from "@/lib/dashboard-client-profile-resolver";
import { createChannelMessage, deregisterClient, registerClient, sendClientHeartbeat } from "@/lib/registry-client";
import type { ChannelAckPayload, ChannelMessagePayload, RegistryAgent, WsMessage } from "@/types";

const REGISTRY_WS = import.meta.env.VITE_REGISTRY_WS ?? "ws://localhost:4999/ws";
const MAX_RECONNECT_DELAY = 30_000;
const DASHBOARD_CLIENT_ID = "client-dashboard-ui";
const DASHBOARD_PROJECT_NAME = "dashboard";
const DASHBOARD_PROJECT_PATH = typeof window !== "undefined"
  ? `${window.location.origin}/dashboard`
  : "dashboard://local";

type RuntimeEventMap = {
  registry: WsMessage;
  channelMessage: ChannelMessagePayload;
  channelAck: ChannelAckPayload;
  status: "connecting" | "connected" | "disconnected" | "error";
};

type RuntimeListener<K extends keyof RuntimeEventMap> = (event: RuntimeEventMap[K]) => void;

class DashboardChannelRuntime {
  private readonly profileResolver = new DefaultDashboardClientProfileResolver();
  private readonly clientProfile: DashboardClientProfile;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private registered = false;
  private started = false;
  private listeners = new Map<keyof RuntimeEventMap, Set<Function>>();

  readonly clientId = DASHBOARD_CLIENT_ID;

  constructor() {
    this.clientProfile = this.profileResolver.resolve({ clientName: "dashboard" });
    this.listeners.set("registry", new Set());
    this.listeners.set("channelMessage", new Set());
    this.listeners.set("channelAck", new Set());
    this.listeners.set("status", new Set());
  }

  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.connect();
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.handleBeforeUnload);
    }
  }

  on<K extends keyof RuntimeEventMap>(event: K, listener: RuntimeListener<K>): () => void {
    const bucket = this.listeners.get(event);
    bucket?.add(listener);
    return () => bucket?.delete(listener);
  }

  async sendMessage(input: {
    conversationId?: string;
    replyTo?: string;
    toAgentId: string;
    content: string;
    taskId?: string;
    meta?: Record<string, unknown>;
    expectsResponse?: boolean;
    requiresAck?: boolean;
    expiresAt?: number;
  }): Promise<ChannelMessagePayload> {
    return createChannelMessage({
      conversationId: input.conversationId,
      replyTo: input.replyTo,
      fromAgentId: this.clientId,
      fromAgentName: "Dashboard",
      toAgentId: input.toAgentId,
      taskId: input.taskId,
      kind: "chat",
      content: input.content,
      meta: input.meta,
      expectsResponse: input.expectsResponse,
      requiresAck: input.requiresAck,
      expiresAt: input.expiresAt,
    });
  }

  getClientRegistration(): RegistryAgent {
    return {
      agentId: this.clientId,
      name: DASHBOARD_PROJECT_NAME,
      url: "",
      wsUrl: "",
      port: 0,
      projectPath: DASHBOARD_PROJECT_PATH,
      projectName: DASHBOARD_PROJECT_NAME,
      projectType: "unknown",
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      healthy: true,
      entryType: "client",
      clientInfo: {
        clientName: "dashboard",
        clientVersion: "web",
      },
      card: {
        name: DASHBOARD_PROJECT_NAME,
        description: "Dashboard web client for agent-bridge channels",
        url: "",
        version: "web",
        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false,
        },
        skills: [],
      },
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    if (this.registered) {
      await deregisterClient(this.clientId).catch(() => undefined);
      this.registered = false;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.handleBeforeUnload);
    }
  }

  private emit<K extends keyof RuntimeEventMap>(event: K, value: RuntimeEventMap[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    for (const listener of bucket) {
      (listener as RuntimeListener<K>)(value);
    }
  }

  private connect(): void {
    if (this.destroyed) return;
    this.emit("status", "connecting");
    this.ws = new WebSocket(REGISTRY_WS);

    this.ws.onopen = () => {
      this.emit("status", "connected");
      this.reconnectDelay = 1_000;
      this.ws?.send(JSON.stringify({ type: "identify", agentId: this.clientId }));
      void this.ensureRegistered();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WsMessage;
        this.emit("registry", msg);
        if (msg.type === "channel.message" && this.clientProfile.acceptsDirectedMessage(msg.data, this.clientId)) {
          this.emit("channelMessage", msg.data);
        }
        if (msg.type === "channel.ack") {
          this.emit("channelAck", msg.data);
        }
      } catch {
        // Ignore malformed messages.
      }
    };

    this.ws.onclose = () => {
      if (!this.destroyed) {
        this.emit("status", "disconnected");
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.emit("status", "error");
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.destroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, this.reconnectDelay);
  }

  private async ensureRegistered(): Promise<void> {
    try {
      await registerClient(this.getClientRegistration());
      this.registered = true;
      this.startHeartbeat();
    } catch {
      // Retry on next heartbeat/reconnect cycle.
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.registered) {
        void this.ensureRegistered();
        return;
      }
      void sendClientHeartbeat(this.clientId).catch(() => {
        this.registered = false;
      });
    }, 30_000);
  }

  private handleBeforeUnload = () => {
    if (!this.registered) return;
    void fetch(`${import.meta.env.VITE_REGISTRY_URL ?? "http://localhost:4999"}/agents/${encodeURIComponent(this.clientId)}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => undefined);
  };
}

export const dashboardChannelRuntime = new DashboardChannelRuntime();
