import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// ── JSON-RPC types ────────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// ── Injection context — correlates a bridge injection with a channel message ─

export interface InjectionContext {
  conversationId: string;
  messageId: string;
  fromAgentId: string;
}

// ── Internal state ────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface ActivePromptState {
  id: number;
  ctx: InjectionContext;
  contentBuffer: string;
  settle: (ok: boolean) => void;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface GeminiAcpClientOptions {
  /** Gemini CLI executable name or path. Default: "gemini" */
  geminiCommand?: string;
  /** Working directory for the spawned gemini process. Default: process.cwd() */
  cwd?: string;
  /** Log ACP messages to stderr for debugging. Default: false */
  debug?: boolean;
  /** Timeout for initialize/session/new requests. Default: 30_000ms */
  initTimeoutMs?: number;
  /** Timeout for session/prompt requests. Default: 120_000ms */
  promptTimeoutMs?: number;
}

export interface GeminiAcpClientEvents {
  agentMessage: [text: string, ctx: InjectionContext];
  turnStarted: [];
  turnCompleted: [];
  sessionReady: [sessionId: string];
  connected: [];
  disconnected: [];
}

/**
 * ACP (Agent Client Protocol) client for Gemini CLI.
 *
 * Spawns `gemini --acp`, communicates over stdio using newline-delimited
 * JSON-RPC 2.0, and maintains a single session across multiple prompts.
 *
 * Startup flow:
 *  1. spawnProcess()           — starts `gemini --acp`
 *  2. performInitialize()      — sends `initialize` handshake
 *  3. openSession()            — sends `session/new`, stores sessionId
 *  4. emit("connected")
 *
 * Per-message flow:
 *  sendPrompt(text, ctx)       — sends `session/prompt`
 *    ← session/update notifications buffer `agent_message_chunk` content
 *    ← session/prompt response → emit("agentMessage", fullText, ctx)
 */
export class GeminiAcpClient extends EventEmitter<GeminiAcpClientEvents> {
  private readonly geminiCommand: string;
  private readonly cwd: string;
  private readonly debug: boolean;
  private readonly initTimeoutMs: number;
  private readonly promptTimeoutMs: number;

  private process: ChildProcess | null = null;
  private _sessionId: string | null = null;
  private _initialized = false;
  private _turnInProgress = false;
  private nextRequestId = 1;

  /** Simple request/response tracking (initialize, session/new) */
  private readonly pendingRequests = new Map<number, PendingRequest>();

  /** State for the currently running session/prompt request */
  private activePrompt: ActivePromptState | null = null;

  constructor(options: GeminiAcpClientOptions = {}) {
    super();
    this.geminiCommand = options.geminiCommand ?? "gemini";
    this.cwd = options.cwd ?? process.cwd();
    this.debug = options.debug ?? false;
    this.initTimeoutMs = options.initTimeoutMs ?? 30_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 120_000;
  }

  // ── Public accessors ────────────────────────────────────────────────────────

  get sessionId(): string | null { return this._sessionId; }
  get initialized(): boolean { return this._initialized; }
  get turnInProgress(): boolean { return this._turnInProgress; }
  get sessionReady(): boolean { return this._sessionId !== null && this._initialized; }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.spawnProcess();
    await this.performInitialize();
    await this.openSession();
    this.emit("connected");
  }

  disconnect(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
    }
    this.process = null;
    this._initialized = false;
    this._sessionId = null;
    this.emit("disconnected");
  }

  // ── Prompt injection ─────────────────────────────────────────────────────────

  /**
   * Send a prompt to the active Gemini session.
   * Returns true when Gemini finishes responding, false on failure/timeout.
   * Emits "agentMessage" with the full response text before returning.
   */
  async sendPrompt(text: string, ctx: InjectionContext): Promise<boolean> {
    if (!this._sessionId) {
      console.error("[GeminiAcpClient] Cannot send prompt: no active session");
      return false;
    }
    if (!this._initialized) {
      console.error("[GeminiAcpClient] Cannot send prompt: not initialized");
      return false;
    }
    if (this._turnInProgress) {
      console.error("[GeminiAcpClient] Cannot send prompt: turn in progress");
      return false;
    }

    const id = this.nextRequestId++;
    this._turnInProgress = true;
    this.emit("turnStarted");

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._turnInProgress = false;
        this.activePrompt = null;
        this.emit("turnCompleted");
        resolve(ok);
      };

      const timer = setTimeout(() => {
        console.error(`[GeminiAcpClient] Prompt id=${id} timed out after ${this.promptTimeoutMs}ms`);
        settle(false);
      }, this.promptTimeoutMs);

      this.activePrompt = { id, ctx, contentBuffer: "", settle };

      this.send({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: {
          sessionId: this._sessionId,
          prompt: [{ type: "text", text }],
        },
      });

      console.error(`[GeminiAcpClient] Sent session/prompt id=${id}`);
    });
  }

  // ── Process management ───────────────────────────────────────────────────────

  private spawnProcess(): void {
    const args = ["--acp"];
    if (this.debug) args.push("--debug");

    this.process = spawn(this.geminiCommand, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
    });

    this.process.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[gemini-acp] ${d.toString()}`);
    });

    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed) this.handleLine(trimmed);
      });
    }

    this.process.on("exit", (code) => {
      console.error(`[GeminiAcpClient] Process exited (code ${code ?? "unknown"})`);
      // Fail all pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error("Gemini process exited unexpectedly"));
      }
      this.pendingRequests.clear();
      // Fail active prompt
      if (this.activePrompt) {
        const p = this.activePrompt;
        this.activePrompt = null;
        p.settle(false);
      }
      this.emit("disconnected");
    });

    this.process.on("error", (err) => {
      console.error(`[GeminiAcpClient] Spawn error: ${err.message}`);
    });
  }

  // ── Message parsing ──────────────────────────────────────────────────────────

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (this.debug) {
      const raw = JSON.stringify(msg);
      console.error(`[GeminiAcpClient] ← ${raw.length > 300 ? raw.slice(0, 300) + "…" : raw}`);
    }

    const hasId = "id" in msg && msg.id !== undefined;
    const hasMethod = "method" in msg && typeof msg.method === "string";
    const hasResult = "result" in msg;
    const hasError = "error" in msg;

    if (hasId && (hasResult || hasError) && !hasMethod) {
      this.handleResponse(msg as unknown as JsonRpcResponse);
    } else if (hasMethod && !hasId) {
      this.handleNotification(msg as unknown as JsonRpcNotification);
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const id = msg.id;

    // Active prompt response — session/prompt resolves here
    if (this.activePrompt?.id === id) {
      const prompt = this.activePrompt;

      if (msg.error) {
        console.error(`[GeminiAcpClient] Prompt id=${id} error: ${msg.error.message}`);
        prompt.settle(false);
        return;
      }

      // Emit accumulated content before settling
      const text = prompt.contentBuffer.trim();
      if (text) {
        this.emit("agentMessage", text, prompt.ctx);
      } else {
        console.error(`[GeminiAcpClient] Prompt id=${id} completed but no content buffered`);
      }

      prompt.settle(true);
      return;
    }

    // Generic pending request (initialize, session/new)
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);

    if (msg.error) {
      pending.reject(new Error(msg.error.message));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    if (msg.method !== "session/update") return;

    const params = msg.params as {
      sessionId?: string;
      update?: {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
      };
    } | undefined;

    const update = params?.update;
    if (!update || !this.activePrompt) return;

    if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
      this.activePrompt.contentBuffer += update.content.text;
    }
  }

  // ── Initialization ───────────────────────────────────────────────────────────

  private async performInitialize(): Promise<void> {
    await this.sendRequest(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "agent-bridge", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: false },
        },
      },
      this.initTimeoutMs,
    );
    this._initialized = true;
    console.error("[GeminiAcpClient] Initialized");
  }

  private async openSession(): Promise<void> {
    const result = await this.sendRequest(
      "session/new",
      { cwd: this.cwd, mcpServers: [] },
      this.initTimeoutMs,
    ) as { sessionId?: string } | null;

    if (!result?.sessionId) {
      throw new Error("session/new did not return a sessionId");
    }
    this._sessionId = result.sessionId;
    console.error(`[GeminiAcpClient] Session ready: ${this._sessionId}`);
    this.emit("sessionReady", this._sessionId);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private send(msg: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      console.error("[GeminiAcpClient] Cannot send: stdin not writable");
      return;
    }
    const line = `${JSON.stringify(msg)}\n`;
    if (this.debug) {
      console.error(`[GeminiAcpClient] → ${line.slice(0, 300)}`);
    }
    this.process.stdin.write(line);
  }

  private sendRequest(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
}
