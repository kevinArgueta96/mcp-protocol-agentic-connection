import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { GeminiAcpClient, type InjectionContext } from "./gemini-acp-client.js";
import { ChannelTransport } from "./channel-transport.js";
import { ChannelClientRuntime } from "./channel-client-runtime.js";
import { RegistryClient } from "./registry-client.js";
import type { ChannelMessage } from "../types/messages.js";

export interface GeminiAcpBridgeOptions {
  registryUrl?: string;
  projectPath?: string;
  /** Gemini CLI executable name or path. Default: "gemini" */
  geminiCommand?: string;
  /** Enable ACP debug logging. Default: false */
  debug?: boolean;
}

interface QueuedMessage {
  message: ChannelMessage;
  retries: number;
}

const MAX_QUEUE_SIZE = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;

/**
 * Full Gemini ACP bridge daemon.
 *
 * Start flow:
 *  1. Spawns `gemini --acp` via GeminiAcpClient
 *  2. Sends ACP initialize + session/new handshake
 *  3. Registers as a client in the registry
 *  4. Subscribes to channel.message events via ChannelClientRuntime
 *  5. On channel.message → injects into Gemini via client.sendPrompt()
 *  6. On agentMessage from Gemini → sends reply back to registry channel
 *
 * Unlike the Codex bridge (which uses a separate TUI connecting to app-server),
 * the Gemini ACP bridge is the sole driver of the gemini --acp process.
 * The spawned process represents the "Gemini client session" visible in the registry.
 */
export class GeminiAcpBridge extends EventEmitter {
  private readonly registryUrl: string;
  private readonly projectPath: string;

  private readonly client: GeminiAcpClient;
  private readonly channelTransport: ChannelTransport;
  private readonly channelRuntime: ChannelClientRuntime;
  private readonly registry: RegistryClient;

  private clientAgentId: string | null = null;
  private stopped = false;

  /** Queue of messages waiting for Gemini to finish its current turn */
  private readonly pendingQueue: QueuedMessage[] = [];

  constructor(options: GeminiAcpBridgeOptions = {}) {
    super();
    this.registryUrl = options.registryUrl ?? "http://localhost:4999";
    this.projectPath = options.projectPath ?? process.cwd();

    this.client = new GeminiAcpClient({
      geminiCommand: options.geminiCommand ?? "gemini",
      cwd: this.projectPath,
      debug: options.debug ?? false,
    });

    this.channelTransport = new ChannelTransport({ registryUrl: this.registryUrl });
    this.channelRuntime = new ChannelClientRuntime({
      transport: this.channelTransport,
      reconnectDelayMs: 5_000,
      maxReconnectAttempts: 10,
    });
    this.registry = new RegistryClient(this.registryUrl);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get status(): {
    ready: boolean;
    sessionId: string | null;
    turnInProgress: boolean;
    queueSize: number;
  } {
    return {
      ready: this.client.sessionReady,
      sessionId: this.client.sessionId,
      turnInProgress: this.client.turnInProgress,
      queueSize: this.pendingQueue.length,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;

    // 1. Connect ACP client — spawns gemini --acp, initializes, opens session
    console.error("[GeminiBridge] Connecting Gemini ACP client…");
    await this.client.connect();

    // 2. Wire client events
    this.wireClientEvents();

    // 3. Register as client in registry — activateClient now connects WS and waits for open
    await this.registerWithRegistry();
    this.wireRuntimeEvents();

    console.error(`[GeminiBridge] Ready. Session: ${this.client.sessionId}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.client.disconnect();
    if (this.clientAgentId) {
      try {
        await this.channelRuntime.deactivateClient?.();
      } catch { /* ignore */ }
    }
  }

  // ── Client event wiring ─────────────────────────────────────────────────────

  private wireClientEvents(): void {
    this.client.on("sessionReady", () => {
      this.drainQueue();
    });

    this.client.on("turnCompleted", () => {
      console.error("[GeminiBridge] Turn completed");
      void this.drainQueue();
    });

    this.client.on("agentMessage", (text, ctx) => {
      console.error(`[GeminiBridge] Agent message (${text.length} chars), sending reply`);
      void this.sendReplyToRegistry(text, ctx);
    });

    this.client.on("disconnected", () => {
      if (!this.stopped) {
        console.error("[GeminiBridge] Gemini ACP client disconnected unexpectedly");
      }
    });
  }

  // ── Registry setup ──────────────────────────────────────────────────────────

  private async registerWithRegistry(): Promise<void> {
    const projectName = basename(this.projectPath);
    this.clientAgentId = this.buildClientAgentId();

    await this.channelRuntime.activateClient({
      agentId: this.clientAgentId,
      name: projectName,
      url: "",
      wsUrl: "",
      port: 0,
      projectPath: this.projectPath,
      projectName,
      projectType: "unknown",
      card: {
        name: projectName,
        description: `Gemini ACP bridge — ${projectName}`,
        url: "",
        version: "0.1.0",
        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false,
        },
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
        skills: [],
      },
      registeredAt: Date.now(),
      entryType: "client" as const,
      clientInfo: { clientName: "gemini", clientVersion: "acp-bridge" },
    });

    console.error(`[GeminiBridge] Registered with registry as ${this.clientAgentId}`);
  }

  private buildClientAgentId(): string {
    const hash = createHash("sha1")
      .update(`gemini-acp-bridge\n${this.projectPath}`)
      .digest("hex")
      .slice(0, 12);
    return `client-gemini-bridge-${hash}`;
  }

  // ── Runtime event wiring ────────────────────────────────────────────────────

  private wireRuntimeEvents(): void {
    this.channelRuntime.on("ws.open", () => {
      console.error("[GeminiBridge] WebSocket connected to registry");
      // Re-identify on every (re)connect so the registry maps this WS to our agentId
      this.channelRuntime.identify();
    });

    this.channelRuntime.on("registry.event", (event) => {
      const e = event as { type?: string };
      console.error(`[GeminiBridge] Registry event: ${e.type ?? "unknown"}`);
    });

    this.channelRuntime.on("channel.message", (message) => {
      if (message.toAgentId && message.toAgentId !== this.clientAgentId) return;
      if (message.fromAgentId === this.clientAgentId) return;

      console.error(
        `[GeminiBridge] Channel message from ${message.fromAgentId} (conv: ${message.conversationId})`,
      );
      this.enqueueOrInject(message);
    });
  }

  // ── Message injection ───────────────────────────────────────────────────────

  private enqueueOrInject(message: ChannelMessage): void {
    if (!this.client.turnInProgress && this.client.sessionReady) {
      this.injectNow(message);
    } else {
      if (this.pendingQueue.length >= MAX_QUEUE_SIZE) {
        const dropped = this.pendingQueue.shift();
        console.error(`[GeminiBridge] Queue full, dropping oldest: ${dropped?.message.messageId}`);
      }
      this.pendingQueue.push({ message, retries: 0 });
      console.error(`[GeminiBridge] Queued message (queue size: ${this.pendingQueue.length})`);
    }
  }

  private injectNow(message: ChannelMessage): void {
    const ctx: InjectionContext = {
      conversationId: message.conversationId,
      messageId: message.messageId,
      fromAgentId: message.fromAgentId,
    };

    const prompt = this.buildInjectionPrompt(message);

    void this.client.sendPrompt(prompt, ctx).then((ok) => {
      if (!ok) {
        console.error(`[GeminiBridge] Prompt failed, re-queuing ${message.messageId}`);
        setTimeout(() => {
          this.pendingQueue.unshift({ message, retries: 1 });
          this.drainQueue();
        }, RETRY_DELAY_MS);
        return;
      }

      void this.channelTransport.postChannelAck({
        conversationId: message.conversationId,
        messageId: message.messageId,
        state: "delivered_to_bridge",
        actorId: this.clientAgentId ?? "gemini-acp-bridge",
        actorType: "bridge",
        detail: "Injected into Gemini via ACP session/prompt",
      });
    });
  }

  private drainQueue(): void {
    if (this.pendingQueue.length === 0) return;
    if (this.client.turnInProgress) return;
    if (!this.client.sessionReady) return;

    const item = this.pendingQueue.shift();
    if (!item) return;

    if (item.retries >= MAX_RETRIES) {
      console.error(`[GeminiBridge] Dropping message ${item.message.messageId} after ${MAX_RETRIES} retries`);
      void this.channelTransport.postChannelAck({
        conversationId: item.message.conversationId,
        messageId: item.message.messageId,
        state: "failed",
        actorId: this.clientAgentId ?? "gemini-acp-bridge",
        actorType: "bridge",
        detail: `Dropped after ${MAX_RETRIES} injection retries`,
      });
      return;
    }

    this.injectNow({ ...item.message });
  }

  private buildInjectionPrompt(message: ChannelMessage): string {
    const sender = message.fromAgentName ?? message.fromAgentId;
    const lines = [
      `[agent-bridge] Channel message from ${sender}:`,
      "",
      message.content,
    ];
    if (message.taskId) lines.push("", `(taskId: ${message.taskId})`);
    if (message.conversationId) lines.push("", `(conversationId: ${message.conversationId})`);
    return lines.join("\n");
  }

  // ── Reply sending ───────────────────────────────────────────────────────────

  private async sendReplyToRegistry(text: string, ctx: InjectionContext): Promise<void> {
    try {
      await this.channelTransport.postChannelMessage({
        fromAgentId: this.clientAgentId!,
        toAgentId: ctx.fromAgentId,
        conversationId: ctx.conversationId,
        replyTo: ctx.messageId,
        content: text,
        kind: "chat",
        expectsResponse: false,
      });

      await this.channelTransport.postChannelAck({
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        state: "answered",
        actorId: this.clientAgentId ?? "gemini-acp-bridge",
        actorType: "bridge",
        detail: "Gemini responded via ACP session/prompt",
      });

      console.error(`[GeminiBridge] Reply sent for conversation ${ctx.conversationId}`);
    } catch (err) {
      console.error(
        `[GeminiBridge] Failed to send reply: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
