import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { GeminiAcpClient, type InjectionContext } from "./gemini-acp-client.js";
import { ChannelTransport } from "./channel-transport.js";
import { ChannelClientRuntime } from "./channel-client-runtime.js";
import { BoundedIdSet } from "./bounded-id-set.js";
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

  /** MessageIds delivered to (or in flight to) the underlying Gemini ACP session.
   *  Built from successful injections + terminal acks owned by this bridge actor
   *  during registry sync. Prevents duplicate prompts on revive/retry/replay.
   *  Bounded to keep memory predictable in long-running daemons. */
  private readonly injectedMessageIds = new BoundedIdSet(5_000);
  private syncInFlight = false;
  /** Periodic re-sync (defense-in-depth): every 5 min the bridge pulls the
   *  registry's snapshot to recover any messages missed via the live WS path. */
  private periodicSyncTimer: NodeJS.Timeout | null = null;

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

    // 4. Recover any messages that arrived while this bridge was offline.
    //    Uses the registry's persisted ack ledger as source of truth.
    await this.syncMissedMessages();

    // 5. Periodic re-sync as defense-in-depth.
    this.startPeriodicSync();

    console.error(`[GeminiBridge] Ready. Session: ${this.client.sessionId}`);
  }

  private startPeriodicSync(periodMs = 5 * 60_000): void {
    if (this.periodicSyncTimer) return;
    this.periodicSyncTimer = setInterval(() => {
      void this.syncMissedMessages();
    }, periodMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }
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
      // Recover any messages that arrived while the WS was disconnected.
      void this.syncMissedMessages();
    });

    this.channelRuntime.on("registry.event", (event) => {
      const e = event as { type?: string };
      console.error(`[GeminiBridge] Registry event: ${e.type ?? "unknown"}`);
    });

    this.channelRuntime.on("channel.message", (message) => {
      if (message.toAgentId && message.toAgentId !== this.clientAgentId) return;
      if (message.fromAgentId === this.clientAgentId) return;

      // Dedup: same channel.message can arrive multiple times — sender retries,
      // conversation revives, sync replays overlapping with live broadcasts.
      if (this.injectedMessageIds.has(message.messageId)) {
        console.error(
          `[GeminiBridge] Skipping already-injected ${message.messageId} (conv: ${message.conversationId})`,
        );
        return;
      }

      console.error(
        `[GeminiBridge] Channel message from ${message.fromAgentId} (conv: ${message.conversationId})`,
      );
      void this.channelTransport.postChannelAck({
        conversationId: message.conversationId,
        messageId: message.messageId,
        state: "delivered_to_bridge",
        actorId: this.clientAgentId ?? "gemini-acp-bridge",
        actorType: "bridge",
        detail: "Gemini ACP bridge received channel message",
      });
      this.enqueueOrInject(message);
    });
  }

  // ── Registry sync ───────────────────────────────────────────────────────────

  /** Replay any messages from the registry that this bridge hasn't yet displayed.
   *
   *  Treats the registry's persisted ack ledger as the source of truth for
   *  "already injected": any ack from this bridge actor with state in
   *  {`displayed_to_client`, `answered`, `failed`} marks the corresponding
   *  message as handled. `delivered_to_bridge` is just receipt by the daemon,
   *  so those messages stay replayable after an interrupted injection. */
  private async syncMissedMessages(): Promise<void> {
    if (this.syncInFlight) return;
    if (!this.clientAgentId) return;
    this.syncInFlight = true;
    try {
      const entries = await this.registry.listChannelConversations();
      let replayed = 0;
      for (const entry of entries) {
        const snapshot = await this.registry.getChannelConversation(entry.conversationId);
        if (!snapshot) continue;

        for (const ack of snapshot.acknowledgements ?? []) {
          if (
            ack.actorId === this.clientAgentId &&
            (ack.state === "displayed_to_client" ||
              ack.state === "answered" ||
              ack.state === "failed")
          ) {
            this.injectedMessageIds.add(ack.messageId);
          }
        }

        for (const msg of snapshot.messages) {
          if (msg.fromAgentId === this.clientAgentId) continue;
          if (msg.toAgentId && msg.toAgentId !== this.clientAgentId) continue;
          if (this.injectedMessageIds.has(msg.messageId)) continue;
          if (msg.expiresAt && msg.expiresAt <= Date.now()) continue;
          console.error(
            `[GeminiBridge] Replaying missed message ${msg.messageId} from ${msg.fromAgentId} (conv: ${msg.conversationId})`,
          );
          this.enqueueOrInject(msg);
          replayed++;
        }
      }
      if (replayed > 0) {
        console.error(`[GeminiBridge] Sync replayed ${replayed} missed message(s) from registry`);
      }
    } catch (err) {
      console.error(
        `[GeminiBridge] Registry sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.syncInFlight = false;
    }
  }

  // ── Message injection ───────────────────────────────────────────────────────

  private enqueueOrInject(message: ChannelMessage): void {
    if (this.pendingQueue.some((item) => item.message.messageId === message.messageId)) {
      console.error(`[GeminiBridge] Skipping already-queued ${message.messageId}`);
      return;
    }
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

  private injectNow(message: ChannelMessage, retries = 0): void {
    const ctx: InjectionContext = {
      conversationId: message.conversationId,
      messageId: message.messageId,
      fromAgentId: message.fromAgentId,
      expectsResponse: message.expectsResponse === true,
    };

    const prompt = this.buildInjectionPrompt(message);

    void this.client.sendPrompt(prompt, ctx).then((ok) => {
      if (!ok) {
        console.error(`[GeminiBridge] Prompt failed, re-queuing ${message.messageId}`);
        setTimeout(() => {
          this.pendingQueue.unshift({ message, retries: retries + 1 });
          this.drainQueue();
        }, RETRY_DELAY_MS);
        return;
      }

      // Record the injection BEFORE the ack so a re-broadcast that races with the
      // ack-write can't slip through the dedup check.
      this.injectedMessageIds.add(message.messageId);
      void this.channelTransport.postChannelAck({
        conversationId: message.conversationId,
        messageId: message.messageId,
        state: "displayed_to_client",
        actorId: this.clientAgentId ?? "gemini-acp-bridge",
        actorType: "bridge",
        detail: "Submitted to Gemini via ACP session/prompt",
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

    this.injectNow(item.message, item.retries);
  }

  private buildInjectionPrompt(message: ChannelMessage): string {
    const sender = message.fromAgentName ?? message.fromAgentId;
    const lines = [
      `[open-agent-bridge] Channel message from ${sender}:`,
      "",
      message.content,
    ];
    lines.push(
      "",
      message.expectsResponse === true
        ? "This channel message asks for a reply. Solve it like a normal task; use local tools if needed. To send the answer back to the sender, call the agent-bridge.reply MCP tool with replyTo equal to this messageId and conversationId equal to this message conversationId."
        : "This channel message does not ask for a reply. Do not send a channel response; treat it as context only.",
    );
    if (message.expectsResponse === true) {
      lines.push("", `(conversationId: ${message.conversationId})`, `(replyTo/messageId: ${message.messageId})`);
    }
    if (message.taskId) lines.push("", `(taskId: ${message.taskId})`);
    if (message.conversationId) lines.push("", `(conversationId: ${message.conversationId})`);
    return lines.join("\n");
  }

  // ── Reply sending ───────────────────────────────────────────────────────────

  private async sendReplyToRegistry(text: string, ctx: InjectionContext): Promise<void> {
    if (!ctx.expectsResponse) {
      console.error(`[GeminiBridge] Suppressing channel reply for fire-and-forget message ${ctx.messageId}`);
      return;
    }

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
