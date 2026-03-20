// Persistent Claude Code process — singleton that stays alive across skill calls.
//
// Claude Code supports --input-format stream-json: a single process accepts
// multiple messages via stdin and maintains context between them.
//
// Protocol:
//   stdin  → {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}\n
//   stdout ← stream of JSON lines ending with {"type":"result",...}
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// ── Path resolution (same logic as claude-execute) ───────────────────────────

function resolveClaudePath(): string {
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  } catch {
    return "claude";
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClaudeResult {
  text: string;
  sessionId: string | null;
  cost: number;
}

interface QueueEntry {
  prompt: string;
  timeoutMs: number;
  resolve: (r: ClaudeResult) => void;
  reject: (e: Error) => void;
}

// ── ClaudeProcess singleton ───────────────────────────────────────────────────

export class ClaudeProcess {
  private static instance: ClaudeProcess | null = null;

  private proc: ChildProcess | null = null;
  private cwd = process.cwd();
  private allowedTools: string[] = ["Read", "Glob", "Grep"];

  private queue: QueueEntry[] = [];
  private processing = false;
  private stdoutBuffer = "";

  // Callbacks for the currently active request
  private activeResolve: ((r: ClaudeResult) => void) | null = null;
  private activeReject: ((e: Error) => void) | null = null;
  private activeTimer: NodeJS.Timeout | null = null;
  private activeResult: ClaudeResult = { text: "", sessionId: null, cost: 0 };

  private constructor() {}

  static getInstance(): ClaudeProcess {
    if (!ClaudeProcess.instance) {
      ClaudeProcess.instance = new ClaudeProcess();
    }
    return ClaudeProcess.instance;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(cwd: string, allowedTools: string[] = ["Read", "Glob", "Grep"]): void {
    if (this.isAlive()) return;

    this.cwd = cwd;
    this.allowedTools = allowedTools;
    this._spawn();
  }

  private _spawn(): void {
    const claudePath = resolveClaudePath();

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--allowedTools", this.allowedTools.join(","),
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CODE_SIMPLE: "1",
    };

    this.proc = spawn(claudePath, args, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.stdoutBuffer = "";

    this.proc.stdout!.on("data", (chunk: Buffer) => this._onData(chunk));

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // Only log non-empty stderr (API errors etc.)
      const trimmed = text.trim();
      if (trimmed) {
        console.error(`[ClaudeProcess] stderr: ${trimmed.slice(0, 200)}`);
      }
    });

    this.proc.on("close", (code) => {
      console.error(`[ClaudeProcess] Process exited (code ${code})`);
      this.proc = null;

      // If there was an active request, fail it
      if (this.activeReject) {
        this._settleActive(null, new Error(`Claude process exited unexpectedly (code ${code})`));
      }
    });

    this.proc.on("error", (err) => {
      console.error(`[ClaudeProcess] Spawn error: ${err.message}`);
      this.proc = null;
      if (this.activeReject) {
        this._settleActive(null, new Error(`Failed to spawn claude: ${err.message}`));
      }
    });

    console.error(`[ClaudeProcess] Started (pid ${this.proc.pid})`);
  }

  stop(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;

    // Drain queue with errors
    if (this.activeReject) {
      this._settleActive(null, new Error("ClaudeProcess stopped"));
    }
    for (const entry of this.queue) {
      entry.reject(new Error("ClaudeProcess stopped"));
    }
    this.queue = [];

    proc.kill("SIGTERM");
    // Give it 3s then force kill
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }, 3_000);
  }

  isAlive(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  send(prompt: string, timeoutMs = 300_000): Promise<ClaudeResult> {
    return new Promise<ClaudeResult>((resolve, reject) => {
      this.queue.push({ prompt, timeoutMs, resolve, reject });
      this._drain();
    });
  }

  // ── Queue worker ──────────────────────────────────────────────────────────

  private _drain(): void {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const entry = this.queue.shift()!;
    this._processEntry(entry);
  }

  private _processEntry(entry: QueueEntry): void {
    // Ensure process is alive; respawn if needed
    if (!this.isAlive()) {
      this._spawn();
    }

    this.activeResolve = entry.resolve;
    this.activeReject = entry.reject;
    this.activeResult = { text: "", sessionId: null, cost: 0 };

    // Set timeout
    this.activeTimer = setTimeout(() => {
      this._settleActive(null, new Error(`claude-execute timed out after ${entry.timeoutMs / 1000}s`));
    }, entry.timeoutMs);

    // Write message to stdin
    const message = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: entry.prompt }],
      },
    });

    try {
      this.proc!.stdin!.write(message + "\n");
    } catch (err) {
      this._settleActive(null, new Error(`Failed to write to claude stdin: ${(err as Error).message}`));
    }
  }

  // ── stdout parsing ────────────────────────────────────────────────────────

  private _onData(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this._parseLine(trimmed);
    }
  }

  private _parseLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // not JSON
    }

    // Accumulate session_id from any message that carries it
    if (typeof msg.session_id === "string") {
      this.activeResult.sessionId = msg.session_id;
    }

    if (msg.type === "result") {
      // Final result — settle the promise
      if (typeof msg.result === "string") {
        this.activeResult.text = msg.result;
      }
      if (typeof msg.total_cost_usd === "number") {
        this.activeResult.cost = msg.total_cost_usd;
      }
      this._settleActive(this.activeResult, null);
    }
  }

  // ── Settle helpers ────────────────────────────────────────────────────────

  private _settleActive(result: ClaudeResult | null, error: Error | null): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }

    const resolve = this.activeResolve;
    const reject = this.activeReject;
    this.activeResolve = null;
    this.activeReject = null;

    this.processing = false;

    if (error && reject) {
      reject(error);
    } else if (result && resolve) {
      resolve(result);
    }

    // Process next item in queue
    setImmediate(() => this._drain());
  }
}
