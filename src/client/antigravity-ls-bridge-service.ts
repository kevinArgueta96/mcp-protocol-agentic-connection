import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectPendingForClient } from "./antigravity-pending.js";
import {
  discoverLsHttpPort,
  getActiveCascadeId,
  sendUserCascadeMessage,
} from "./antigravity-ls-client.js";
import { RegistryClient } from "./registry-client.js";

export interface AntigravityLsBridgeOptions {
  projectPath: string;
  registryUrl?: string;
  /** Explicit agy client session agentId; otherwise resolved by project+identity. */
  clientId?: string;
  /** Channel namespace to resolve the agy session for (default: global). */
  identity?: string;
  pollIntervalMs?: number;
  /** Don't re-inject the same messageId within this window (ms). */
  retryIntervalMs?: number;
  verbose?: boolean;
}

interface StateEntry {
  lastInjectedMessageId?: string;
  lastInjectedAt?: number;
}
interface State {
  conversations: Record<string, StateEntry>;
}

/**
 * Polls the registry for channel messages pending for an Antigravity (`agy`)
 * session and injects each, as a real user turn, into the live TUI via the
 * Cascade Language Server (`SendUserCascadeMessage`). This is the only way an
 * idle `agy` processes a channel message without the user typing.
 *
 * Requires `agy` to have an active conversation/trajectory in the workspace
 * (a fresh session with none → nothing to inject into).
 */
export class AntigravityLsBridgeService {
  private readonly registry: RegistryClient;
  private readonly statePath: string;
  private readonly pollIntervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly identity: string;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: AntigravityLsBridgeOptions) {
    this.registry = new RegistryClient(options.registryUrl ?? "http://localhost:4999");
    this.statePath = join(options.projectPath, ".open-agent-bridge", "antigravity-ls-state.json");
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.retryIntervalMs = options.retryIntervalMs ?? 30_000;
    this.identity = options.identity ?? "global";
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.tick();
    this.scheduleNextTick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<number> {
    const clientId = await this.resolveClientId();
    if (!clientId) {
      this.log("No Antigravity client session resolved for this project/identity");
      return 0;
    }

    const pending = await collectPendingForClient(this.registry, clientId);
    this.log(`Resolved agy client ${clientId} (identity ${this.identity}); ${pending.length} pending`);
    if (pending.length === 0) return 0;

    const port = await discoverLsHttpPort();
    if (!port) {
      this.log("Could not discover the agy Language Server HTTP port (is agy running?)");
      return 0;
    }
    const cascadeId = await getActiveCascadeId(port, this.options.projectPath);
    if (!cascadeId) {
      this.log("No active cascade/trajectory in this workspace — open a conversation in agy first");
      return 0;
    }

    const state = this.loadState();
    const now = Date.now();
    let injected = 0;

    for (const msg of pending) {
      const entry = state.conversations[msg.conversationId] ?? {};
      const already = entry.lastInjectedMessageId === msg.messageId;
      if (already && typeof entry.lastInjectedAt === "number" && now - entry.lastInjectedAt < this.retryIntervalMs) {
        continue;
      }

      // `fromAgentName` is the sender's project name (often the same as ours),
      // so include the unambiguous agentId too.
      const sender = msg.fromAgentName ? `${msg.fromAgentName} [${msg.fromAgentId}]` : msg.fromAgentId;
      const text =
        `📨 New open-agent-bridge channel message from ${sender} (conversation ${msg.conversationId}):\n\n` +
        `${msg.content}\n\n` +
        "Reply through the channel tools (reply / message_client_session).";

      try {
        await sendUserCascadeMessage(port, cascadeId, text);
        injected++;
        entry.lastInjectedMessageId = msg.messageId;
        entry.lastInjectedAt = now;
        state.conversations[msg.conversationId] = entry;
        this.saveState(state);
        this.log(`Injected message ${msg.messageId} from ${sender} into cascade ${cascadeId}`);
      } catch (err) {
        this.log(`Injection failed for ${msg.messageId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return injected;
  }

  private async resolveClientId(): Promise<string | undefined> {
    if (this.options.clientId) return this.options.clientId;
    const agents = await this.registry.listAgents({ project: this.options.projectPath });
    // Must be the Antigravity session specifically — a project can host other
    // clients (e.g. Claude) in the same identity namespace, so filter by the
    // antigravity/agy client name, not just entryType+identity.
    const match = agents.find(
      (a) =>
        a.entryType === "client" &&
        (a.identity ?? "global") === this.identity &&
        /antigravity|agy/i.test(a.clientInfo?.clientName ?? ""),
    );
    return match?.agentId;
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.log(`tick error: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.scheduleNextTick();
    }
  }

  private loadState(): State {
    try {
      if (existsSync(this.statePath)) return JSON.parse(readFileSync(this.statePath, "utf8")) as State;
    } catch {
      // corrupt → reset
    }
    return { conversations: {} };
  }

  private saveState(state: State): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  private log(message: string): void {
    if (this.options.verbose) console.error(`[antigravity-ls] ${message}`);
  }
}
