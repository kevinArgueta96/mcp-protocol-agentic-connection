import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ChannelAck } from "../types/messages.js";
import { RegistryClient } from "./registry-client.js";
import { readCurrentCodexSession } from "./codex-session-files.js";
import { discoverCodexPaneForProject, getTmuxPaneInfo, isInteractiveCodexPane } from "./codex-runtime-discovery.js";

const execFileAsync = promisify(execFile);

interface SidecarStateEntry {
  lastInjectedMessageId?: string;
  lastInjectedAt?: number;
}

interface SidecarState {
  conversations: Record<string, SidecarStateEntry>;
}

export interface CodexTmuxBridgeOptions {
  registryUrl?: string;
  projectPath: string;
  clientId?: string;
  tmuxPane?: string;
  pollIntervalMs?: number;
  retryIntervalMs?: number;
  verbose?: boolean;
}

interface PendingConversation {
  conversationId: string;
  messageId: string;
  fromAgentId: string;
  fromAgentName?: string;
  taskId?: string;
  content: string;
  createdAt: number;
}

function latestAckByMessage(acks: ChannelAck[]): Map<string, ChannelAck> {
  const latest = new Map<string, ChannelAck>();
  for (const ack of acks) latest.set(ack.messageId, ack);
  return latest;
}

function previewText(value: string, max = 180): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return "(empty)";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

export class CodexTmuxBridgeService {
  private readonly registry: RegistryClient;
  private readonly statePath: string;
  private readonly pollIntervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly clientId?: string;
  private readonly verbose: boolean;
  private readonly tmuxPane?: string;
  private readonly runningConversations = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: CodexTmuxBridgeOptions) {
    this.registry = new RegistryClient(options.registryUrl ?? "http://localhost:4999");
    this.statePath = join(options.projectPath, ".agent-bridge", "codex-tmux-sidecar-state.json");
    this.clientId = options.clientId;
    this.tmuxPane = options.tmuxPane;
    this.verbose = options.verbose ?? false;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.retryIntervalMs = options.retryIntervalMs ?? 30_000;
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

  async runOnce(): Promise<PendingConversation[]> {
    const client = await this.resolveCodexClient();
    if (!client) {
      this.log("No Codex client session resolved");
      return [];
    }

    const pane = await this.resolveTmuxPane();
    if (!pane) {
      this.log(`No tmux pane bound for client ${client.agentId}`);
      return [];
    }

    this.log(`Resolved Codex client ${client.agentId} with tmux pane ${pane}`);

    const pending = await this.collectPendingConversations(client.agentId);
    const state = this.loadState();
    const now = Date.now();

    for (const conversation of pending) {
      if (this.runningConversations.has(conversation.conversationId)) continue;

      const entry = state.conversations[conversation.conversationId] ?? {};
      const alreadyInjected = entry.lastInjectedMessageId === conversation.messageId;
      const retryBlocked =
        alreadyInjected &&
        typeof entry.lastInjectedAt === "number" &&
        now - entry.lastInjectedAt < this.retryIntervalMs;

      if (retryBlocked) continue;

      this.runningConversations.add(conversation.conversationId);
      void this.injectConversationPrompt(pane, conversation).finally(() => {
        this.runningConversations.delete(conversation.conversationId);
      });

      entry.lastInjectedMessageId = conversation.messageId;
      entry.lastInjectedAt = now;
      state.conversations[conversation.conversationId] = entry;
      this.saveState(state);
    }

    return pending;
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } finally {
      this.scheduleNextTick();
    }
  }

  private async resolveTmuxPane(): Promise<string | undefined> {
    if (this.tmuxPane) {
      const pane = await getTmuxPaneInfo(this.tmuxPane);
      if (isInteractiveCodexPane(pane)) return this.tmuxPane;
    }

    const session = readCurrentCodexSession(this.options.projectPath);
    if (session?.tmuxPane) {
      const pane = await getTmuxPaneInfo(session.tmuxPane);
      if (isInteractiveCodexPane(pane)) return session.tmuxPane;
    }

    const discovered = await discoverCodexPaneForProject(this.options.projectPath);
    return discovered?.paneId;
  }

  private async resolveCodexClient() {
    const entries = await this.registry.listAgents();
    const clients = entries.filter((entry) => entry.entryType === "client");

    if (this.clientId) {
      const clientId = this.clientId;
      const exact = clients.find((entry) => entry.agentId === clientId || entry.agentId.startsWith(clientId));
      if (exact) return exact;
      this.log(`Configured clientId ${clientId} not found; falling back to project-based discovery`);
    }

    const sessionFile = readCurrentCodexSession(this.options.projectPath);
    if (sessionFile?.clientAgentId) {
      const current = clients.find((entry) => entry.agentId === sessionFile.clientAgentId);
      if (current) return current;
    }

    return clients.find((entry) =>
      entry.projectPath === this.options.projectPath &&
      typeof entry.clientInfo?.clientName === "string" &&
      entry.clientInfo.clientName.toLowerCase().includes("codex")
    );
  }

  private async collectPendingConversations(clientId: string): Promise<PendingConversation[]> {
    const list = await this.registry.listChannelConversations({ pendingOnly: true });
    const pending: PendingConversation[] = [];

    for (const entry of list) {
      const snapshot = await this.registry.getChannelConversation(entry.conversationId);
      if (!snapshot) continue;

      const ackMap = latestAckByMessage(snapshot.acknowledgements);
      const pendingMessages = snapshot.messages.filter((message) => {
        if (!message.expectsResponse) return false;
        if (message.toAgentId && message.toAgentId !== clientId) return false;
        const ack = ackMap.get(message.messageId);
        return ack?.state !== "answered" && ack?.state !== "failed";
      });

      if (pendingMessages.length === 0) continue;
      const latestPending = pendingMessages[pendingMessages.length - 1]!;
      pending.push({
        conversationId: snapshot.conversationId,
        messageId: latestPending.messageId,
        fromAgentId: latestPending.fromAgentId,
        fromAgentName: latestPending.fromAgentName,
        taskId: latestPending.taskId,
        content: latestPending.content,
        createdAt: latestPending.createdAt,
      });
    }

    return pending.sort((a, b) => b.createdAt - a.createdAt);
  }

  private buildInjectedPrompt(conversation: PendingConversation): string {
    const sender = conversation.fromAgentName ?? conversation.fromAgentId;
    return `Agent-bridge: mensaje pendiente de ${sender}; conversationId=${conversation.conversationId}; replyTo=${conversation.messageId}; preview=${previewText(conversation.content)}. Revisa channel_inbox y responde solo si es simple.`;
  }

  private async injectConversationPrompt(pane: string, conversation: PendingConversation): Promise<void> {
    const prompt = this.buildInjectedPrompt(conversation);
    const paneInfo = await getTmuxPaneInfo(pane);
    if (!isInteractiveCodexPane(paneInfo)) {
      this.log(`Skipping injection for ${conversation.conversationId}; pane ${pane} is not running Codex`);
      return;
    }

    this.log(`Injecting conversation ${conversation.conversationId} into tmux pane ${pane}`);

    // Write prompt to a temp file and load it as a named buffer to avoid
    // special-character issues with set-buffer. The -dr flags on paste-buffer
    // delete the buffer afterwards and paste in raw mode (no trailing newline),
    // so the Enter we send next is always a clean submit keystroke.
    const bufferName = `agent-bridge-${process.pid}-${Date.now()}`;
    const tmpFile = join(tmpdir(), `${bufferName}.txt`);
    await writeFile(tmpFile, prompt, "utf8");
    try {
      await execFileAsync("tmux", ["load-buffer", "-b", bufferName, tmpFile]);
      await execFileAsync("tmux", ["paste-buffer", "-dr", "-b", bufferName, "-t", pane]);
    } finally {
      await rm(tmpFile, { force: true }).catch(() => undefined);
    }

    // Give the Codex TUI a short window to settle after the paste before
    // sending Enter — without this delay Enter may land before the input
    // field has registered the pasted text and only inserts a newline.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await execFileAsync("tmux", ["send-keys", "-t", pane, "Enter"]);
  }

  private loadState(): SidecarState {
    try {
      if (!existsSync(this.statePath)) return { conversations: {} };
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<SidecarState>;
      return { conversations: parsed.conversations ?? {} };
    } catch {
      return { conversations: {} };
    }
  }

  private saveState(state: SidecarState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  private log(message: string): void {
    if (!this.verbose) return;
    console.error(`[Codex Tmux Sidecar] ${message}`);
  }
}
