import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

// ── JSON-RPC types ───────────────────────────────────────────────────────────

interface JsonRpcMessage {
  method?: string;
  id?: number;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── Injection context — correlates a bridge injection with a channel message ─

export interface InjectionContext {
  conversationId: string;
  messageId: string;
  fromAgentId: string;
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface CodexAppServerClientEvents {
  agentMessage: [text: string, ctx: InjectionContext | null];
  turnStarted: [turnId: string];
  turnCompleted: [turnId: string];
  threadDetected: [threadId: string];
  connected: [];
  disconnected: [];
}

export interface CodexAppServerClientOptions {
  /** WebSocket URL of the codex app-server. Default: ws://127.0.0.1:4500 */
  appServerUrl?: string;
}

/**
 * Direct WebSocket client to the Codex app-server.
 *
 * Connects as an independent client (separate from the TUI) and performs the
 * required JSON-RPC `initialize` handshake. Monitors broadcast notifications
 * for turn lifecycle and agentMessage capture. Exposes injectMessage() to
 * send turn/start requests directly.
 */
export class CodexAppServerClient extends EventEmitter<CodexAppServerClientEvents> {
  private readonly appServerUrl: string;

  private ws: WebSocket | null = null;
  private _initialized = false;

  // Turn tracking
  private _turnInProgress = false;
  private activeTurnIds = new Set<string>();

  // Thread tracking
  private _currentThreadId: string | null = null;

  // Request ID management
  private nextRequestId = 1;
  /** Pending requests waiting for a response, keyed by id */
  private readonly pendingRequests = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();

  // Injection tracking
  private readonly injectionContexts = new Map<number, InjectionContext>();
  private lastInjectionRequestId: number | null = null;

  // Item buffering for streaming agentMessage content
  private readonly itemContentBuffers = new Map<string, string>();

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    this.appServerUrl = options.appServerUrl ?? "ws://127.0.0.1:4500";
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get turnInProgress(): boolean {
    return this._turnInProgress;
  }

  get currentThreadId(): string | null {
    return this._currentThreadId;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Connect to the app-server and perform the initialize handshake.
   */
  async connect(): Promise<void> {
    await this.openWebSocket();
    await this.performInitialize();
    console.error(`[CodexClient] Connected and initialized with ${this.appServerUrl}`);
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this._initialized = false;
  }

  /**
   * Inject a message directly into the app-server as a turn/start request.
   */
  injectMessage(text: string, ctx: InjectionContext): boolean {
    if (!this._currentThreadId) {
      console.error("[CodexClient] Cannot inject: no thread ID yet");
      return false;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[CodexClient] Cannot inject: WS not open");
      return false;
    }
    if (!this._initialized) {
      console.error("[CodexClient] Cannot inject: not initialized");
      return false;
    }
    if (this._turnInProgress) {
      console.error("[CodexClient] Cannot inject: turn in progress");
      return false;
    }

    const requestId = this.nextRequestId++;
    this.injectionContexts.set(requestId, ctx);
    this.lastInjectionRequestId = requestId;

    this.send({
      method: "turn/start",
      id: requestId,
      params: {
        threadId: this._currentThreadId,
        input: [{ type: "text", text }],
      },
    });

    console.error(
      `[CodexClient] Injected turn/start id=${requestId} thread=${this._currentThreadId}`,
    );
    return true;
  }

  // ── WebSocket connection ───────────────────────────────────────────────────

  private openWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.appServerUrl);

      ws.once("open", () => {
        this.ws = ws;
        this.emit("connected");
        resolve();
      });

      ws.on("message", (data) => this.handleMessage(String(data)));

      ws.on("close", () => {
        console.error("[CodexClient] WS closed");
        this.ws = null;
        this._initialized = false;
        this.emit("disconnected");
      });

      ws.on("error", (err) => {
        console.error("[CodexClient] WS error:", err.message);
        if (this.ws === null) reject(err);
      });
    });
  }

  // ── Initialize handshake ───────────────────────────────────────────────────

  private async performInitialize(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      clientInfo: { name: "agent-bridge", version: "0.1.0" },
      capabilities: {},
      protocolVersion: "0.1.0",
    });

    console.error("[CodexClient] Initialize response:", JSON.stringify(result));

    // Send initialized notification (no id)
    this.send({ method: "initialized" });
    this._initialized = true;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    const hasId = "id" in msg && msg.id !== undefined;
    const hasMethod = "method" in msg && msg.method !== undefined;
    const hasResult = "result" in msg;
    const hasError = "error" in msg;

    if (hasId && (hasResult || hasError) && !hasMethod) {
      // JSON-RPC response to our request
      this.handleResponse(msg);
    } else if (hasMethod && hasId) {
      // Server-initiated request (e.g. server.client_name) — respond
      this.handleServerRequest(msg);
    } else if (hasMethod && !hasId) {
      // Notification (broadcast from app-server)
      this.handleNotification(msg);
    }
  }

  private handleResponse(msg: JsonRpcMessage): void {
    const id = msg.id!;

    // Check if this is a response to a turn/start injection
    if (this.injectionContexts.has(id)) {
      if (msg.error) {
        console.error(
          `[CodexClient] Injection id=${id} rejected: ${msg.error.message}`,
        );
        this.injectionContexts.delete(id);
      }
      // Don't delete context on success — we need it when agentMessage arrives
    }

    // Resolve pending request promise
    const pending = this.pendingRequests.get(id);
    if (pending) {
      this.pendingRequests.delete(id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private handleServerRequest(msg: JsonRpcMessage): void {
    const method = msg.method!;
    const id = msg.id!;

    // Respond to known server-initiated requests
    switch (method) {
      case "server.client_name":
        this.send({ id, result: "agent-bridge" });
        console.error("[CodexClient] Responded to server.client_name");
        break;
      case "server.client_version":
        this.send({ id, result: "0.1.0" });
        console.error("[CodexClient] Responded to server.client_version");
        break;
      default:
        // Unknown server request — respond with empty result to avoid timeout
        console.error(`[CodexClient] Unknown server request: ${method}, responding with null`);
        this.send({ id, result: null });
        break;
    }
  }

  private handleNotification(msg: JsonRpcMessage): void {
    const method = msg.method!;
    const params = msg.params as Record<string, unknown> | undefined;

    // Log all notifications for debugging (first 300 chars)
    const raw = JSON.stringify(msg);
    console.error(`[CodexClient] notif: ${raw.length > 300 ? raw.slice(0, 300) + "…" : raw}`);

    switch (method) {
      case "thread/started": {
        // threadId is nested under params.thread.id
        const thread = params?.thread as Record<string, unknown> | undefined;
        const threadId = (thread?.id as string | undefined) ?? (params?.threadId as string | undefined);
        if (threadId) {
          this._currentThreadId = threadId;
          console.error(`[CodexClient] Thread detected via thread/started: ${threadId}`);
          this.emit("threadDetected", threadId);
          void this.subscribeToThread(threadId);
        }
        break;
      }

      case "thread/status/changed": {
        // Use this as the primary turn-state signal since turn/started and
        // turn/completed may not be broadcast to non-owner connections.
        const threadId = params?.threadId as string | undefined;
        const status = params?.status as Record<string, unknown> | undefined;
        const statusType = status?.type as string | undefined;

        // Detect threadId even if we missed thread/started
        if (threadId && !this._currentThreadId) {
          this._currentThreadId = threadId;
          console.error(`[CodexClient] Thread detected via status/changed: ${threadId}`);
          this.emit("threadDetected", threadId);
          void this.subscribeToThread(threadId);
        }

        if (statusType === "idle") {
          if (this._turnInProgress) {
            this._turnInProgress = false;
            // Emit a synthetic turnCompleted so the bridge drains its queue
            this.emit("turnCompleted", "status-idle");
          }
        } else if (statusType === "active") {
          this._turnInProgress = true;
        }

        console.error(`[CodexClient] Thread status: ${statusType}`);
        break;
      }

      case "turn/started": {
        const turnId = params?.turnId as string | undefined;
        if (turnId) {
          this.activeTurnIds.add(turnId);
          this._turnInProgress = true;
          this.emit("turnStarted", turnId);
        }
        break;
      }

      case "turn/completed": {
        const turnId = params?.turnId as string | undefined;
        if (turnId) {
          this.activeTurnIds.delete(turnId);
          if (this.activeTurnIds.size === 0) {
            this._turnInProgress = false;
          }
          this.emit("turnCompleted", turnId);
        }
        break;
      }

      case "item/started": {
        const item = params?.item as Record<string, unknown> | undefined;
        if (item?.type === "agentMessage" && item.id) {
          this.itemContentBuffers.set(String(item.id), "");
        }
        break;
      }

      case "item/agentMessage/delta": {
        const itemId = params?.itemId as string | undefined;
        const delta = (params?.delta as Record<string, unknown> | undefined)
          ?.text;
        if (
          itemId &&
          typeof delta === "string" &&
          this.itemContentBuffers.has(itemId)
        ) {
          this.itemContentBuffers.set(
            itemId,
            (this.itemContentBuffers.get(itemId) ?? "") + delta,
          );
        }
        break;
      }

      case "item/completed": {
        const item = params?.item as Record<string, unknown> | undefined;
        if (item?.type === "agentMessage" && item.id) {
          const itemId = String(item.id);
          const buffered = this.itemContentBuffers.get(itemId);
          this.itemContentBuffers.delete(itemId);

          // Extract text: prefer streaming buffer, fallback to item.content array
          let text = buffered ?? "";
          if (!text) {
            const contentArr = item.content as
              | Array<{ type: string; text?: string }>
              | undefined;
            text = (contentArr ?? [])
              .filter((c) => c.type === "output_text" && c.text)
              .map((c) => c.text ?? "")
              .join("");
          }

          if (text) {
            const ctx =
              this.lastInjectionRequestId !== null
                ? (this.injectionContexts.get(this.lastInjectionRequestId) ??
                    null)
                : null;

            if (ctx) {
              this.injectionContexts.delete(this.lastInjectionRequestId!);
              this.lastInjectionRequestId = null;
            }

            this.emit("agentMessage", text, ctx);
          }
        }
        break;
      }
    }
  }

  // ── Thread subscription ────────────────────────────────────────────────────

  /**
   * Call thread/resume on our connection to subscribe to notifications for this
   * thread. Without this the app-server may only send turn/item notifications to
   * the TUI connection that created/owns the thread.
   */
  private async subscribeToThread(threadId: string): Promise<void> {
    try {
      const result = await this.sendRequest("thread/resume", { threadId });
      console.error(`[CodexClient] thread/resume result: ${JSON.stringify(result)}`);
    } catch (err) {
      // thread/resume may fail if not supported or thread not found — ignore
      console.error(`[CodexClient] thread/resume failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendRequest(
    method: string,
    params: unknown,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.send({ method, id, params });
    });
  }
}
