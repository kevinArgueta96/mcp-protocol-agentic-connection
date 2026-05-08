import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { CodexAppServerClient, type InjectionContext } from "./codex-app-server-client.js";
import { ChannelTransport } from "./channel-transport.js";
import { ChannelClientRuntime } from "./channel-client-runtime.js";
import { BoundedIdSet } from "./bounded-id-set.js";
import { RegistryClient } from "./registry-client.js";
import type { ChannelMessage } from "../types/messages.js";

export interface CodexAppServerBridgeOptions {
  registryUrl?: string;
  projectPath?: string;
  /** Port for the codex app-server process. Default: 4500 */
  appServerPort?: number;
}

interface QueuedMessage {
  message: ChannelMessage;
  retries: number;
  enqueuedAt: number;
}

const MAX_QUEUE_SIZE = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;
const QUEUE_STALE_CHECK_MS = 5_000;
const NO_TUI_QUEUE_TIMEOUT_MS = 30_000;

/**
 * Full Codex app-server bridge daemon.
 *
 * Start flow:
 *  1. Spawns `codex app-server --listen ws://127.0.0.1:<appServerPort>`
 *  2. Waits for the app-server to be ready (polls /readyz)
 *  3. Connects to the app-server directly via CodexAppServerClient (initialize handshake)
 *  4. Connects to the registry via ChannelClientRuntime
 *  5. On channel.message: injects into Codex via client.injectMessage()
 *  6. On agentMessage from client: sends reply back to registry
 *
 * The Codex TUI connects directly to the app-server:
 *   codex --remote ws://127.0.0.1:<appServerPort>
 */
export class CodexAppServerBridge extends EventEmitter {
  private readonly registryUrl: string;
  private readonly projectPath: string;
  private readonly appServerPort: number;

  private readonly client: CodexAppServerClient;
  private readonly channelTransport: ChannelTransport;
  private readonly channelRuntime: ChannelClientRuntime;
  private readonly registry: RegistryClient;

  private appServerProcess: ChildProcess | null = null;
  private clientAgentId: string | null = null;
  private stopped = false;

  /** Queue of messages waiting for Codex to become idle */
  private readonly pendingQueue: QueuedMessage[] = [];

  /** MessageIds that have been (or are being) delivered to the underlying Codex
   *  process. Built from (a) successful injections, and (b) terminal acks from
   *  this same bridge actor when syncing the registry on startup/reconnect.
   *  Used to avoid double-injection on revive/retry/replay. Bounded to keep
   *  memory predictable in long-running daemons. */
  private readonly injectedMessageIds = new BoundedIdSet(5_000);
  private syncInFlight = false;
  /** Periodic re-sync (defense-in-depth): every 5 min the bridge pulls the
   *  registry's snapshot to recover any messages missed via the live WS path
   *  (e.g. half-open socket, lost broadcast). */
  private periodicSyncTimer: NodeJS.Timeout | null = null;
  /** Checks queued messages that cannot be injected because no Codex TUI has
   *  attached to the app-server thread yet. */
  private queueHealthTimer: NodeJS.Timeout | null = null;
  private noTuiWarningTimer: NodeJS.Timeout | null = null;

  constructor(options: CodexAppServerBridgeOptions = {}) {
    super();
    this.registryUrl = options.registryUrl ?? "http://localhost:4999";
    this.projectPath = options.projectPath ?? process.cwd();
    this.appServerPort = options.appServerPort ?? 4500;

    this.client = new CodexAppServerClient({
      appServerUrl: `ws://127.0.0.1:${this.appServerPort}`,
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
    threadId: string | null;
    turnInProgress: boolean;
    appServerWsUrl: string;
    queueSize: number;
  } {
    return {
      ready: this.client.currentThreadId !== null,
      threadId: this.client.currentThreadId,
      turnInProgress: this.client.turnInProgress,
      appServerWsUrl: `ws://127.0.0.1:${this.appServerPort}`,
      queueSize: this.pendingQueue.length,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;

    // 1. Spawn codex app-server
    await this.spawnAppServer();

    // 2. Connect bridge client directly to app-server (initialize handshake)
    await this.client.connect();

    // 3. Wire client events
    this.wireClientEvents();

    // 4. Register as client in registry — activateClient now connects WS and waits for open
    await this.registerWithRegistry();
    this.wireRuntimeEvents();

    // 5. Recover any messages that arrived while this bridge was offline.
    //    Uses the registry's persisted ack ledger as source of truth.
    await this.syncMissedMessages();

    // 6. Periodic re-sync as defense-in-depth.
    this.startPeriodicSync();
    this.startQueueHealthCheck();
    this.scheduleNoTuiWarning();

    const appServerWsUrl = `ws://127.0.0.1:${this.appServerPort}`;
    console.error(`[Bridge] Ready. Start Codex TUI with:`);
    console.error(`  codex --remote ${appServerWsUrl}`);
  }

  private startPeriodicSync(periodMs = 5 * 60_000): void {
    if (this.periodicSyncTimer) return;
    this.periodicSyncTimer = setInterval(() => {
      void this.syncMissedMessages();
    }, periodMs);
  }

  private startQueueHealthCheck(periodMs = QUEUE_STALE_CHECK_MS): void {
    if (this.queueHealthTimer) return;
    this.queueHealthTimer = setInterval(() => {
      void this.failStaleQueuedMessages();
    }, periodMs);
  }

  private scheduleNoTuiWarning(delayMs = 10_000): void {
    if (this.noTuiWarningTimer) return;
    this.noTuiWarningTimer = setTimeout(() => {
      this.noTuiWarningTimer = null;
      if (this.stopped || this.client.currentThreadId) return;
      console.error(
        `[Bridge] WARN: No Codex TUI attached. Bridge will queue messages until you run:\n` +
          `  codex --remote ws://127.0.0.1:${this.appServerPort}`,
      );
    }, delayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }
    if (this.queueHealthTimer) {
      clearInterval(this.queueHealthTimer);
      this.queueHealthTimer = null;
    }
    if (this.noTuiWarningTimer) {
      clearTimeout(this.noTuiWarningTimer);
      this.noTuiWarningTimer = null;
    }

    this.client.disconnect();
    if (this.appServerProcess && !this.appServerProcess.killed) {
      this.appServerProcess.kill("SIGTERM");
    }
    if (this.clientAgentId) {
      try {
        await this.channelRuntime.deactivateClient?.();
      } catch { /* ignore */ }
    }
  }

  // ── App-server spawning ─────────────────────────────────────────────────────

  private async spawnAppServer(): Promise<void> {
    const listenUrl = `ws://127.0.0.1:${this.appServerPort}`;
    console.error(`[Bridge] Spawning codex app-server on ${listenUrl}`);

    this.appServerProcess = spawn(
      "codex",
      ["app-server", "--enable", "tui_app_server", "--listen", listenUrl],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: this.projectPath,
      },
    );

    this.appServerProcess.stdout?.on("data", (d: Buffer) => {
      process.stderr.write(`[app-server] ${d.toString()}`);
    });
    this.appServerProcess.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[app-server] ${d.toString()}`);
    });
    this.appServerProcess.on("exit", (code) => {
      if (!this.stopped) {
        console.error(`[Bridge] app-server exited (code ${code ?? "unknown"})`);
      }
    });

    await this.waitForAppServer(listenUrl);
  }

  private async waitForAppServer(wsUrl: string, maxWaitMs = 15_000): Promise<void> {
    const healthUrl = wsUrl.replace("ws://", "http://") + "/readyz";
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) {
          console.error(`[Bridge] app-server ready at ${healthUrl}`);
          return;
        }
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Codex app-server did not become ready within ${maxWaitMs}ms`);
  }

  // ── Client event wiring ─────────────────────────────────────────────────────

  private wireClientEvents(): void {
    this.client.on("threadDetected", (threadId) => {
      console.error(`[Bridge] Thread detected: ${threadId}`);
      this.drainQueue();
    });

    this.client.on("turnStarted", (turnId) => {
      console.error(`[Bridge] Turn started: ${turnId}`);
    });

    this.client.on("turnCompleted", (turnId) => {
      console.error(`[Bridge] Turn completed: ${turnId}`);
      void this.drainQueue();
    });

    this.client.on("agentMessage", (text, ctx) => {
      if (!ctx) return;
      console.error(`[Bridge] agentMessage captured (${text.length} chars), sending reply`);
      void this.sendReplyToRegistry(text, ctx);
    });

    this.client.on("disconnected", () => {
      console.error(`[Bridge] App-server client disconnected`);
    });
  }

  // ── Registry client setup ───────────────────────────────────────────────────

  private async registerWithRegistry(): Promise<void> {
    const projectName = basename(this.projectPath);
    this.clientAgentId = this.buildClientAgentId();

    const registration = {
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
        description: `Codex app-server bridge — ${projectName}`,
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
      clientInfo: { clientName: "codex", clientVersion: "app-server-bridge" },
    };

    await this.channelRuntime.activateClient(registration);
    console.error(`[Bridge] Registered with registry as ${this.clientAgentId}`);
  }

  private buildClientAgentId(): string {
    const hash = createHash("sha1")
      .update(`codex-app-bridge\n${this.projectPath}`)
      .digest("hex")
      .slice(0, 12);
    return `client-codex-bridge-${hash}`;
  }

  // ── Runtime event wiring ───────────────────────────────────────────────────

  private wireRuntimeEvents(): void {
    this.channelRuntime.on("ws.open", () => {
      console.error("[Bridge] WebSocket connected to registry");
      // Re-identify so the registry maps this WS to our agentId for targeted delivery.
      this.channelRuntime.identify();
      // Recover any messages that may have arrived while the WS was disconnected.
      void this.syncMissedMessages();
    });

    this.channelRuntime.on("channel.message", (message) => {
      if (message.toAgentId && message.toAgentId !== this.clientAgentId) return;
      if (message.fromAgentId === this.clientAgentId) return;

      // Dedup: the same channel.message can arrive multiple times — e.g. when the
      // sender retries `POST /channel/messages`, when a conversation is revived,
      // or when a sync replays a snapshot that overlaps with live broadcasts.
      if (this.injectedMessageIds.has(message.messageId)) {
        console.error(
          `[Bridge] Skipping already-injected ${message.messageId} (conv: ${message.conversationId})`,
        );
        return;
      }

      console.error(
        `[Bridge] Channel message received from ${message.fromAgentId} (conv: ${message.conversationId})`,
      );
      void this.channelTransport.postChannelAck({
        conversationId: message.conversationId,
        messageId: message.messageId,
        state: "delivered_to_bridge",
        actorId: this.clientAgentId ?? "codex-app-bridge",
        actorType: "bridge",
        detail: "Codex app-server bridge received channel message",
      });
      this.enqueueOrInject(message);
    });
  }

  // ── Registry sync ───────────────────────────────────────────────────────────

  /** Replay any messages from the registry that this bridge hasn't yet displayed.
   *
   *  We treat the registry's persisted ack ledger as the source of truth for
   *  "did this bridge already submit this message to Codex?". A message is
   *  considered handled only after this bridge records `displayed_to_client`,
   *  `answered`, or `failed`. `delivered_to_bridge` is intentionally not
   *  terminal: it only means the daemon saw the channel message, and those are
   *  exactly the messages sync must recover if injection was interrupted. */
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

        // Build the set of messageIds that this bridge actor has already handled.
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

        // Replay messages that target us (or are broadcast) and haven't been handled.
        for (const msg of snapshot.messages) {
          if (msg.fromAgentId === this.clientAgentId) continue;
          if (msg.toAgentId && msg.toAgentId !== this.clientAgentId) continue;
          if (this.injectedMessageIds.has(msg.messageId)) continue;
          if (msg.expiresAt && msg.expiresAt <= Date.now()) continue;
          console.error(
            `[Bridge] Replaying missed message ${msg.messageId} from ${msg.fromAgentId} (conv: ${msg.conversationId})`,
          );
          this.enqueueOrInject(msg);
          replayed++;
        }
      }
      if (replayed > 0) {
        console.error(`[Bridge] Sync replayed ${replayed} missed message(s) from registry`);
      }
    } catch (err) {
      console.error(
        `[Bridge] Registry sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.syncInFlight = false;
    }
  }

  // ── Message injection ───────────────────────────────────────────────────────

  private enqueueOrInject(message: ChannelMessage): void {
    if (this.pendingQueue.some((item) => item.message.messageId === message.messageId)) {
      console.error(`[Bridge] Skipping already-queued ${message.messageId}`);
      return;
    }
    if (!this.client.turnInProgress && this.client.currentThreadId) {
      this.injectNow(message);
    } else {
      if (this.pendingQueue.length >= MAX_QUEUE_SIZE) {
        const dropped = this.pendingQueue.shift();
        console.error(`[Bridge] Queue full, dropping oldest: ${dropped?.message.messageId}`);
      }
      this.pendingQueue.push({ message, retries: 0, enqueuedAt: Date.now() });
      console.error(`[Bridge] Queued message (queue size: ${this.pendingQueue.length})`);
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
    const injected = this.client.injectMessage(prompt, ctx);

    if (!injected) {
      console.error(`[Bridge] Injection failed, re-queuing ${message.messageId}`);
      this.pendingQueue.unshift({ message, retries: retries + 1, enqueuedAt: Date.now() });
      setTimeout(() => this.drainQueue(), RETRY_DELAY_MS);
    } else {
      // Record the injection BEFORE the ack so a re-broadcast that races with the
      // ack-write can't slip through the dedup check.
      this.injectedMessageIds.add(message.messageId);
      void this.channelTransport.postChannelAck({
        conversationId: message.conversationId,
        messageId: message.messageId,
        state: "displayed_to_client",
        actorId: this.clientAgentId ?? "codex-app-bridge",
        actorType: "bridge",
        detail: "Submitted to Codex app-server via turn/start",
      });
    }
  }

  private drainQueue(): void {
    if (this.pendingQueue.length === 0) return;
    if (this.client.turnInProgress) return;
    if (!this.client.currentThreadId) return;

    const item = this.pendingQueue.shift();
    if (item) {
      if (item.retries >= MAX_RETRIES) {
        console.error(`[Bridge] Dropping message ${item.message.messageId} after ${MAX_RETRIES} retries`);
        void this.channelTransport.postChannelAck({
          conversationId: item.message.conversationId,
          messageId: item.message.messageId,
          state: "failed",
          actorId: this.clientAgentId ?? "codex-app-bridge",
          actorType: "bridge",
          detail: `Dropped after ${MAX_RETRIES} injection retries`,
        });
        return;
      }
      this.injectNow(item.message, item.retries);
    }
  }

  private async failStaleQueuedMessages(now = Date.now()): Promise<void> {
    if (this.pendingQueue.length === 0) return;
    if (this.client.currentThreadId) return;

    const stillPending: QueuedMessage[] = [];
    const stale: QueuedMessage[] = [];
    for (const item of this.pendingQueue) {
      if (now - item.enqueuedAt >= NO_TUI_QUEUE_TIMEOUT_MS) stale.push(item);
      else stillPending.push(item);
    }

    if (stale.length === 0) return;
    this.pendingQueue.length = 0;
    this.pendingQueue.push(...stillPending);

    const detail =
      `No Codex TUI attached to bridge app-server. Run: ` +
      `codex --remote ws://127.0.0.1:${this.appServerPort}`;
    for (const item of stale) {
      console.error(`[Bridge] Failing queued message ${item.message.messageId}: ${detail}`);
      await this.channelTransport.postChannelAck({
        conversationId: item.message.conversationId,
        messageId: item.message.messageId,
        state: "failed",
        actorId: this.clientAgentId ?? "codex-app-bridge",
        actorType: "bridge",
        detail,
      });
    }
  }

  private buildInjectionPrompt(message: ChannelMessage): string {
    const sender = message.fromAgentName ?? message.fromAgentId;
    const lines = [
      `[open-agent-bridge] Mensaje de canal de ${sender}:`,
      ``,
      message.content,
    ];
    lines.push(
      "",
      message.expectsResponse === true
        ? "Este mensaje solicita respuesta. Resuélvelo como una tarea normal: puedes usar herramientas locales si son necesarias (por ejemplo shell, lectura de archivos o búsqueda). Para devolver la respuesta al remitente, usa el MCP agent-bridge.reply con replyTo igual al messageId de este mensaje y conversationId igual al conversationId de este mensaje."
        : "Este mensaje no solicita respuesta. No envíes una respuesta de canal; solo tenlo en cuenta como contexto.",
    );
    if (message.expectsResponse === true) {
      lines.push("", `(conversationId: ${message.conversationId})`, `(replyTo/messageId: ${message.messageId})`);
    }
    if (message.taskId) lines.push(``, `(taskId: ${message.taskId})`);
    return lines.join("\n");
  }

  // ── Reply sending ───────────────────────────────────────────────────────────

  private async sendReplyToRegistry(text: string, ctx: InjectionContext): Promise<void> {
    if (!ctx.expectsResponse) {
      console.error(`[Bridge] Suppressing channel reply for fire-and-forget message ${ctx.messageId}`);
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
        actorId: this.clientAgentId ?? "codex-app-bridge",
        actorType: "bridge",
        detail: "Codex responded via agentMessage",
      });

      console.error(`[Bridge] Reply sent for conversation ${ctx.conversationId}`);
    } catch (err) {
      console.error(
        `[Bridge] Failed to send reply: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
