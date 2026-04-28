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
  /** Reset the idle timer. Called from `handleNotification` whenever a
   *  session/update arrives for this prompt — that way the timeout measures
   *  *idle time* (no progress) rather than total wall-clock time, so a long
   *  turn that keeps streaming chunks doesn't get cut off. */
  resetIdle: () => void;
}

/** Subset of the `initialize` response we care about. The full response also
 *  carries `agentCapabilities` and `agentInfo` per the ACP spec, but the bridge
 *  only needs `protocolVersion` for logging and `authMethods` to decide whether
 *  to call `authenticate`. */
interface InitializeResult {
  protocolVersion: number;
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface GeminiAcpClientOptions {
  /** Gemini CLI executable name or path. Default: "gemini" */
  geminiCommand?: string;
  /** Working directory for the spawned gemini process. Default: process.cwd() */
  cwd?: string;
  /** Log ACP messages to stderr for debugging. Default: false */
  debug?: boolean;
  /** Timeout for initialize/session/new requests. Default: 60_000ms.
   *  Bumped from 30 s because Gemini CLI's `initialize` handler awaits
   *  `config.initialize()` which loads cached credentials / OAuth state and
   *  can be slow on cold start. */
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
    this.initTimeoutMs = options.initTimeoutMs ?? 60_000;
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
    const initResult = await this.performInitialize();
    await this.maybeAuthenticate(initResult);
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
      let timer: NodeJS.Timeout;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._turnInProgress = false;
        this.activePrompt = null;
        this.emit("turnCompleted");
        resolve(ok);
      };

      // Idle timeout: the prompt is considered stuck only if Gemini stops
      // emitting session/update notifications for `promptTimeoutMs`. Long turns
      // that keep streaming chunks (e.g. a chain of tool calls + thinking) are
      // not cut off mid-flight just because the wall clock passed the budget.
      const armTimer = (): void => {
        if (settled) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          console.error(
            `[GeminiAcpClient] Prompt id=${id} idle for ${this.promptTimeoutMs}ms — giving up`,
          );
          settle(false);
        }, this.promptTimeoutMs);
      };
      armTimer();

      this.activePrompt = { id, ctx, contentBuffer: "", settle, resetIdle: armTimer };

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

    // stderr is normally just diagnostic chatter, but some Gemini CLI builds
    // accidentally write valid JSON-RPC frames there too. We forward the bytes
    // for visibility AND scan each line: if it parses as JSON-RPC, hand it to
    // handleLine() the same as a stdout line. This makes the bridge robust to
    // versions that mux stdout/stderr inconsistently without changing happy-path
    // behaviour for well-behaved versions.
    if (this.process.stderr) {
      const rlErr = createInterface({ input: this.process.stderr, crlfDelay: Infinity });
      rlErr.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        process.stderr.write(`[gemini-acp] ${line}\n`);
        if (trimmed.startsWith("{") && trimmed.includes('"jsonrpc"')) {
          this.handleLine(trimmed);
        }
      });
    }

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
    } else if (hasMethod && hasId && !hasResult && !hasError) {
      // Incoming request from Gemini (e.g. session/request_permission)
      this.handleIncomingRequest(msg as { id: number; method: string; params?: unknown });
    } else if (hasMethod && !hasId) {
      this.handleNotification(msg as unknown as JsonRpcNotification);
    }
  }

  private handleIncomingRequest(msg: { id: number; method: string; params?: unknown }): void {
    if (msg.method === "session/request_permission") {
      // Auto-approve: pick the first "allow" option available
      const params = msg.params as {
        options?: { optionId: string; kind?: string }[];
      } | undefined;
      const options = params?.options ?? [];
      // Prefer the broadest "allow_always" option available so subsequent
      // tool calls in the same session don't require another round-trip per
      // call. Gemini exposes variants like:
      //   - proceed_always_server  → all tools from this MCP server
      //   - proceed_always_tool    → this specific tool
      //   - proceed_always         → this whole session
      //   - proceed_once           → just this call
      // Choosing "allow_always" with a server-scoped optionId lets the agent
      // execute long tool chains without us having to ack every step.
      const allowAlways = options.find((o) => o.kind === "allow_always");
      const chosen =
        allowAlways ??
        options.find((o) => o.kind === "allow_once") ??
        options[0];

      console.error(
        `[GeminiAcpClient] Permission request id=${msg.id} — auto-approving with "${chosen?.optionId ?? "proceed_once"}" (kind=${chosen?.kind ?? "?"})`,
      );

      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { optionId: chosen?.optionId ?? "proceed_once" },
      });
      return;
    }

    // Unknown request — respond with a generic error so Gemini doesn't hang
    console.error(`[GeminiAcpClient] Unknown incoming request: ${msg.method} id=${msg.id}`);
    this.send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
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

    // Any session/update — message chunks, tool call updates, agent thoughts —
    // counts as "Gemini is alive and working". Reset the idle timer so we don't
    // cut off long-running turns that keep streaming progress.
    this.activePrompt.resetIdle();

    if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
      this.activePrompt.contentBuffer += update.content.text;
    }
  }

  // ── Initialization ───────────────────────────────────────────────────────────

  private async performInitialize(): Promise<InitializeResult> {
    // Shape per https://agentclientprotocol.com/protocol/initialization
    //
    // We deliberately keep this MINIMAL and only declare capabilities that exist
    // in the spec. Older versions of agent-bridge sent a non-standard `auth: {
    // terminal: false }` field which some Gemini CLI builds reject silently —
    // they parse the request but never write a response, causing the bridge to
    // time out at 30 s. See docs/channel-reliability.md (Bug 12).
    const result = (await this.sendRequest(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "agent-bridge", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      this.initTimeoutMs,
    )) as InitializeResult | null;

    this._initialized = true;
    const authCount = result?.authMethods?.length ?? 0;
    console.error(
      `[GeminiAcpClient] Initialized (protocolVersion=${result?.protocolVersion ?? "?"}, authMethods=${authCount})`,
    );
    return result ?? { protocolVersion: 1, authMethods: [] };
  }

  /** Per the ACP spec, the `initialize` response carries `authMethods: []`. An
   *  empty array means the agent is already authenticated (env var, OAuth cache,
   *  etc.). A non-empty array means the client MUST call `authenticate` before
   *  any further request, or the agent will hang on `session/new`.
   *
   *  We pick the first listed method and try it. If the agent rejects it, we
   *  surface a clear error so the operator can `export GEMINI_API_KEY=...` or
   *  run `gemini` once in a TTY to set up OAuth — instead of staring at an
   *  opaque 30 s timeout. */
  private async maybeAuthenticate(initResult: InitializeResult): Promise<void> {
    const methods = initResult.authMethods ?? [];
    if (methods.length === 0) return;

    const first = methods[0]!;
    console.error(
      `[GeminiAcpClient] Agent requires authentication; trying methodId=${first.id} (name=${first.name ?? "?"})`,
    );
    try {
      await this.sendRequest(
        "authenticate",
        { methodId: first.id },
        this.initTimeoutMs,
      );
      console.error("[GeminiAcpClient] Authenticated");
    } catch (err) {
      const allIds = methods.map((m) => m.id).join(", ");
      throw new Error(
        `Gemini ACP authenticate(${first.id}) failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Available methods: [${allIds}]. Set GEMINI_API_KEY / GOOGLE_API_KEY in your environment, ` +
          `or run \`gemini\` once in a TTY to complete OAuth.`,
      );
    }
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

  private sendRequest(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      const startedAt = Date.now();

      // Empirically Gemini's `config.initialize()` can take 30–60 s on a cold
      // start (loading cached OAuth, refreshing tokens, etc.). Without progress
      // output the operator sees a frozen terminal and assumes the bridge is
      // broken. A 10 s heartbeat keeps the session feeling alive without
      // spamming.
      const heartbeat = setInterval(() => {
        const elapsedMs = Date.now() - startedAt;
        console.error(
          `[GeminiAcpClient] ⏳ ${method} (id=${id}) still waiting after ${Math.round(elapsedMs / 1000)}s ` +
            `(timeout in ${Math.max(0, Math.round((timeoutMs - elapsedMs) / 1000))}s)`,
        );
      }, 10_000);

      const timer = setTimeout(() => {
        clearInterval(heartbeat);
        this.pendingRequests.delete(id);
        // For `initialize`, the most common cause of a timeout is that Gemini's
        // `config.initialize()` is blocked waiting for credentials. Surface a
        // hint instead of the bare timeout message so the operator doesn't have
        // to reverse-engineer it.
        const hint = method === "initialize"
          ? `\n  Most likely cause: Gemini CLI is not authenticated and is hanging on credential setup.\n` +
            `  Fix: export GEMINI_API_KEY=... (key from https://aistudio.google.com/apikey),\n` +
            `       or run \`gemini\` once in a TTY to complete OAuth, then retry.`
          : "";
        reject(new Error(`Request ${method} (id=${id}) timed out after ${timeoutMs}ms${hint}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          clearInterval(heartbeat);
          const elapsedMs = Date.now() - startedAt;
          if (elapsedMs > 1_000) {
            // Only log timing for slow responses (>1 s). Fast hot-path requests
            // don't need the noise.
            console.error(`[GeminiAcpClient] ✓ ${method} (id=${id}) responded in ${elapsedMs}ms`);
          }
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          clearInterval(heartbeat);
          reject(err);
        },
      });

      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
}
