/**
 * MCP Adapter — Bridges local A2A agents as MCP tools for Claude Code, Codex, Gemini CLI
 *
 * AUTO MODE (default):
 *   If no registry is running at localhost:4999, starts one in-process.
 *   Also auto-starts a local agent for the current working directory.
 *   This means `mcp start` is fully self-contained — no manual setup needed.
 *
 * MANUAL MODE:
 *   Run registry + agents separately, then `mcp start` discovers them.
 */

import { McpServer, ResourceTemplate, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { RegistryClient } from "../client/registry-client.js";
import { ChannelTransport } from "../client/channel-transport.js";
import { ChannelClientRuntime } from "../client/channel-client-runtime.js";
import { ConversationService } from "../client/conversation-service.js";
import { DefaultClientProfileResolver, type ClientBehaviorProfile } from "../client/client-profile-resolver.js";
import { loadMcpBridgeConfig, resolveInboxFirstClientConfig, type McpBridgeConfig, type ResolvedInboxFirstClientConfig } from "./config.js";
import { A2AClient } from "../client/a2a-client.js";
import { RegistryServer } from "../registry/server.js";
import { AgentServer } from "../agent/server.js";
import { CodexProxy } from "./proxies/codex-proxy.js";
import { GeminiProxy } from "./proxies/gemini-proxy.js";
import type { RegistryEntry, AgentMessage, ChannelMessage } from "../types/messages.js";
import type { Task, Part, Message } from "../types/a2a.js";
import { WebSocket } from "ws";
import { clearCurrentCodexSession, readCurrentCodexSession, writeCurrentCodexSession } from "../client/codex-session-files.js";
import { readCurrentGeminiSession, writeCurrentGeminiSession, clearCurrentGeminiSession } from "../client/gemini-session-files.js";
import { detectCurrentTmuxBinding } from "../client/codex-tmux.js";

export interface McpAdapterOptions {
  registryUrl?: string;
  /** Auto-start registry + local agent if none found (default: true) */
  auto?: boolean;
  /** Project path for the auto-started agent (default: cwd) */
  projectPath?: string;
  /** Register per-agent skill tools in addition to meta-tools (default: false) */
  registerSkillTools?: boolean;
  /** Enable Claude Code AI backend for the auto-started embedded agent (default: false) */
  useClaudeCode?: boolean;
  /** Optional path to .agent-bridge.mcp.yml */
  configPath?: string;
  /** Auto-start a detached Codex tmux sidecar when the connected client is Codex */
  codexSidecar?: boolean;
  /** Poll interval for the detached Codex tmux sidecar */
  codexSidecarPollIntervalMs?: number;
  /** Retry interval for the same pending message in the Codex tmux sidecar */
  codexSidecarRetryIntervalMs?: number;
  /** Auto-start a detached Gemini tmux sidecar when the connected client is Gemini */
  geminiSidecar?: boolean;
  /** Poll interval for the detached Gemini tmux sidecar */
  geminiSidecarPollIntervalMs?: number;
  /** Retry interval for the same pending message in the Gemini tmux sidecar */
  geminiSidecarRetryIntervalMs?: number;
}

function toolPrefix(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_").toLowerCase();
}

/** Extract a human-readable response from an A2A Task object.
 *  Handles text, data, and file parts across all artifacts.
 *  Falls back to status.message parts, then raw JSON. */
function extractTaskResponse(task: unknown): string {
  const taskObj = task as Partial<Task>;

  // 1. Artifacts (primary response channel)
  const artifactParts: Part[] = taskObj?.artifacts?.flatMap((a) => a.parts) ?? [];
  if (artifactParts.length > 0) {
    return artifactParts.map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "data") return JSON.stringify(p.data, null, 2);
      if (p.type === "file") return `[File: ${p.file.name ?? p.file.uri ?? "binary"}]`;
      return JSON.stringify(p);
    }).join("\n");
  }

  // 2. Status message parts (simple skill responses)
  const statusMsg = taskObj?.status?.message as Message | undefined;
  const statusParts: Part[] = statusMsg?.parts ?? [];
  if (statusParts.length > 0) {
    return statusParts.map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "data") return JSON.stringify(p.data, null, 2);
      return JSON.stringify(p);
    }).join("\n");
  }

  // 3. Fallback: raw JSON
  return JSON.stringify(task, null, 2);
}

function formatAgentsSummary(agents: RegistryEntry[]): string {
  if (agents.length === 0) {
    return "No agents currently connected. Start one with: agent-bridge start <project-path>";
  }
  const runnableAgents = agents.filter((a) => a.entryType !== "client" || a.card.skills.length > 0);
  const clients = agents.filter((a) => a.entryType === "client" && a.card.skills.length === 0);

  return [
    `${agents.length} entry(ies) connected via agent-bridge:\n`,
    runnableAgents.length > 0 ? "Agents with skills:\n" : "Agents with skills:\n  (none)",
    ...runnableAgents.map((a) => {
      const skills = a.card.skills.map((s) => `    • ${s.id}: ${s.description}`).join("\n");
      return [
        `Agent: ${a.name}  [${a.agentId.slice(0, 8)}]`,
        `  Project: ${a.projectPath}`,
        `  Type:    ${a.projectType}${a.entryType === "client" ? " (client — no skills)" : ""}`,
        `  Status:  ${a.healthy ? "healthy" : "unhealthy"}`,
        `  Skills:\n${skills}`,
      ].join("\n");
    }),
    "",
    clients.length > 0 ? "Client sessions via channels:\n" : "Client sessions via channels:\n  (none)",
    ...clients.map((a) => [
      `Client: ${a.name}  [${a.agentId.slice(0, 8)}]`,
      `  Project: ${a.projectPath}`,
      `  Client:  ${a.clientInfo?.clientName ?? "unknown"} ${a.clientInfo?.clientVersion ?? ""}`.trimEnd(),
      `  Status:  ${a.healthy ? "healthy" : "unhealthy"}`,
      "  Use:     message_client_session",
    ].join("\n")),
  ].join("\n");
}

export class McpAgentBridge {
  private server: McpServer;
  private registry: RegistryClient;
  private channelTransport: ChannelTransport;
  private channelRuntime: ChannelClientRuntime;
  private conversationService: ConversationService;
  private readonly profileResolver = new DefaultClientProfileResolver();
  private readonly codexProxy: CodexProxy;
  private readonly geminiProxy: GeminiProxy;
  private readonly bridgeConfig: McpBridgeConfig;
  private clientProfile: ClientBehaviorProfile;
  private inboxFirstConfig: ResolvedInboxFirstClientConfig;
  private options: Required<McpAdapterOptions>;
  private clientAgentId: string | null = null;
  private clientActivating = false;
  private embeddedAgent: AgentServer | null = null;
  private embeddedRegistry: RegistryServer | null = null;
  private registryWs: WebSocket | null = null;
  private pendingResponses = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private inboxReminderTimers = new Map<string, NodeJS.Timeout>();
  private inboxPollTimer: NodeJS.Timeout | null = null;
  private surfacedInboxMessageIds = new Set<string>();
  private agentToolMap = new Map<string, RegisteredTool[]>();
  private codexSidecarProcess: ChildProcess | null = null;
  private geminiSidecarProcess: ChildProcess | null = null;

  constructor(options: McpAdapterOptions = {}) {
    this.options = {
      registryUrl: "http://localhost:4999",
      auto: true,
      projectPath: process.cwd(),
      registerSkillTools: false,
      useClaudeCode: false,
      configPath: "",
      codexSidecar: false,
      codexSidecarPollIntervalMs: 2_000,
      codexSidecarRetryIntervalMs: 30_000,
      geminiSidecar: false,
      geminiSidecarPollIntervalMs: 2_000,
      geminiSidecarRetryIntervalMs: 30_000,
      ...options,
    };
    this.bridgeConfig = loadMcpBridgeConfig(this.options.projectPath, this.options.configPath || undefined);
    this.registry = new RegistryClient(this.options.registryUrl);
    this.channelTransport = new ChannelTransport({ registryUrl: this.options.registryUrl });
    this.channelRuntime = new ChannelClientRuntime({
      transport: this.channelTransport,
      reconnectDelayMs: 5_000,
      maxReconnectAttempts: 5,
    });
    this.conversationService = new ConversationService(this.channelRuntime);
    this.codexProxy = new CodexProxy(this.conversationService);
    this.geminiProxy = new GeminiProxy(this.conversationService);
    this.clientProfile = this.profileResolver.resolve({ clientName: "codex" });
    this.inboxFirstConfig = resolveInboxFirstClientConfig(this.bridgeConfig, this.clientProfile.id);
    this.server = new McpServer(
      { name: "agent-bridge", version: "0.1.0" },
      {
        capabilities: { experimental: { "claude/channel": {} } },
        instructions:
          "You are connected to agent-bridge, a multi-agent communication hub. " +
          "Connected agents can send you channel events through your current client profile. " +
          "Use list_agents to discover available agents and client sessions, agent_health to check runnable agents, " +
          "ask_agent for A2A agents with skills/HTTP endpoints, and message_client_session for passive client sessions over channels. " +
          "Use reply to respond to incoming channel events. " +
          "If your client behaves inbox-first, use channel_inbox to review inbound channel messages before replying.",
      },
    );
    this.setupChannelRuntime();
  }

  async start(transport: "stdio" | "http" = "stdio", httpPort = 6000): Promise<void> {
    // ── 1. Ensure registry + at least one agent is running ─────────────────
    const agents = await this.ensureInfrastructure();

    // ── 1b. Register shutdown cleanup for embedded processes ───────────────
    const shutdownEmbedded = async () => {
      if (this.embeddedAgent) {
        try { await this.embeddedAgent.stop(); } catch { /* ignore */ }
        this.embeddedAgent = null;
      }
      if (this.embeddedRegistry) {
        try { await this.embeddedRegistry.stop(); } catch { /* ignore */ }
        this.embeddedRegistry = null;
      }
    };
    process.once("SIGINT", () => void shutdownEmbedded().then(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdownEmbedded().then(() => process.exit(0)));

    // ── 1c. Connect WS to registry for message relay ──────────────────────
    this.connectRegistryWs();

    // ── 2. Register all tools, resources, prompts ──────────────────────────
    this.registerMetaTools();
    if (this.options.registerSkillTools && agents.length > 0) {
      this.registerAgentSkillTools(agents);
    }
    this.registerResources(agents);
    this.registerPrompts(agents);

    // ── 3. Setup client detection (must be before connect) ─────────────────
    this.setupClientDetection();

    // ── 4. Connect transport ───────────────────────────────────────────────
    if (transport === "stdio") {
      const stdioTransport = new StdioServerTransport();
      await this.server.connect(stdioTransport);
      console.error(`[MCP] agent-bridge ready. ${agents.length} agent(s) connected.`);
      if (agents.length > 0) {
        console.error("[MCP] Agents:\n" + agents.map((a) => `  • ${a.name} → ${a.projectPath}`).join("\n"));
      }
    } else {
      await this.startHttpTransport(httpPort, agents);
    }
  }

  // ── Registry WebSocket connection ──────────────────────────────────────────

  private connectRegistryWs(): void {
    this.channelRuntime.connect();
  }

  private setupChannelRuntime(): void {
    this.channelRuntime.on("ws.open", () => {
      this.registryWs = this.channelRuntime.getWebSocket();
      console.error("[MCP] WebSocket connected to registry");
      // Refresh local store on every reconnect so channel_inbox stays accurate
      void this.syncRegistryToLocalStore();
    });

    this.channelRuntime.on("ws.close", () => {
      this.registryWs = null;
    });

    this.channelRuntime.on("registry.event", (msg) => {
      if (!msg || typeof msg !== "object") return;
      const event = msg as { type?: string; data?: unknown; agents?: unknown };

      if (event.type === "snapshot" && Array.isArray(event.agents)) {
        const snapshotAgents = event.agents as RegistryEntry[];
        const snapshotIds = new Set(snapshotAgents.map((a) => a.agentId));
        for (const trackedId of this.agentToolMap.keys()) {
          if (!snapshotIds.has(trackedId)) this.removeAgentTools(trackedId);
        }
        if (this.options.registerSkillTools) {
          for (const agent of snapshotAgents) {
            if (agent.entryType !== "client" && agent.card?.skills?.length > 0) {
              this.addAgentTools(agent);
            }
          }
        }
        return;
      }

      if (event.type === "agent.registered" && event.data) {
        const entry = event.data as RegistryEntry;
        if (this.options.registerSkillTools && entry.entryType !== "client" && entry.card?.skills?.length > 0) {
          this.addAgentTools(entry);
          console.error(`[MCP] New agent discovered: ${entry.name} (${entry.card.skills.length} skills)`);
        }
        return;
      }

      if (event.type === "agent.deregistered" || event.type === "agent.removed") {
        const agentId = (event.data as { agentId: string } | undefined)?.agentId;
        if (agentId) this.removeAgentTools(agentId);
        return;
      }

      if (event.type === "agent.unhealthy") {
        const agentId = (event.data as { agentId: string } | undefined)?.agentId;
        if (agentId) this.setAgentToolsEnabled(agentId, false);
        return;
      }

      if (event.type === "agent.heartbeat") {
        const agentId = (event.data as { agentId: string } | undefined)?.agentId;
        if (agentId) this.setAgentToolsEnabled(agentId, true);
      }
    });

    this.channelRuntime.on("channel.message", (channelMessage) => {
      if (!this.clientProfile.acceptsChannelMessage(channelMessage, this.clientAgentId)) return;

      void this.postChannelAck({
        conversationId: channelMessage.conversationId,
        messageId: channelMessage.messageId,
        state: "delivered_to_bridge",
        actorId: this.clientAgentId ?? "mcp-adapter",
        actorType: "bridge",
        detail: "Message received by MCP bridge",
      });

      const notification = this.buildInboundChannelNotification(channelMessage);
      if (!notification) return;
      this.surfacedInboxMessageIds.add(channelMessage.messageId);
      void this.server.server.notification(notification).then(() => this.postChannelAck({
        conversationId: channelMessage.conversationId,
        messageId: channelMessage.messageId,
        state: "displayed_to_client",
        actorId: this.clientAgentId ?? "mcp-adapter",
        actorType: "bridge",
        detail: this.clientProfile.deliveryMode === "inbox-first"
          ? "Inbox reminder forwarded to client"
          : "Message forwarded to client channel",
      })).catch(() => {
        // Ignore notification failures; WS relay remains alive.
      });

      if (this.clientProfile.deliveryMode === "inbox-first" && this.inboxFirstConfig.sendReminderNotifications) {
        this.scheduleInboxReminder(channelMessage);
      }
    });

    this.channelRuntime.on("channel.ack", (ack) => {
      if (ack.state === "answered" || ack.state === "failed") {
        this.clearInboxReminder(ack.conversationId, ack.messageId);
      }
    });

    this.channelRuntime.on("legacy.notify", (notify) => {
      const notification = this.clientProfile.mapLegacyNotify(notify);
      if (!notification) return;
      void this.server.server.notification(notification);
    });

    this.channelRuntime.on("agent.message", (agentMsg) => {
      if (agentMsg.type === "task.request") {
        if (!this.clientAgentId || agentMsg.toAgentId !== this.clientAgentId) {
          return;
        }

        const notification = this.buildTaskRequestNotification(agentMsg);
        if (!notification) return;
        void this.server.server.notification(notification);
      }

      if (agentMsg.type === "task.response" && agentMsg.taskId) {
        const pending = this.pendingResponses.get(agentMsg.taskId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingResponses.delete(agentMsg.taskId);
          pending.resolve(agentMsg.payload);
        }
      }
    });
  }

  private scheduleInboxReminder(message: ChannelMessage): void {
    const key = this.getInboxReminderKey(message.conversationId, message.messageId);
    this.clearInboxReminder(message.conversationId, message.messageId);

    if (!this.inboxFirstConfig.repeatReminders) {
      return;
    }

    const timer = setInterval(() => {
      const snapshot = this.conversationService.getSnapshot(message.conversationId);
      const stillPending = snapshot?.pendingMessages.some((pending) => pending.messageId === message.messageId);
      if (!stillPending) {
        this.clearInboxReminder(message.conversationId, message.messageId);
        return;
      }

      void this.server.server.notification({
        method: "notifications/message",
        params: {
          level: "info",
          logger: "agent-bridge.channel",
          data: {
            content:
              `Pending channel message from ${message.fromAgentName ?? message.fromAgentId}. ` +
              `Use channel_inbox to review and reply. Conversation: ${message.conversationId}.`,
            meta: {
              conversationId: message.conversationId,
              messageId: message.messageId,
              fromAgentId: message.fromAgentId,
              fromAgentName: message.fromAgentName,
              taskId: message.taskId,
              type: "inbox-reminder",
            },
          },
        },
      }).catch(() => {
        // Ignore reminder failures.
      });
    }, this.inboxFirstConfig.reminderIntervalMs);

    this.inboxReminderTimers.set(key, timer);
  }

  private clearInboxReminder(conversationId: string, messageId: string): void {
    const key = this.getInboxReminderKey(conversationId, messageId);
    const timer = this.inboxReminderTimers.get(key);
    if (!timer) return;
    clearInterval(timer);
    this.inboxReminderTimers.delete(key);
  }

  private getInboxReminderKey(conversationId: string, messageId: string): string {
    return `${conversationId}:${messageId}`;
  }

  /** Fetch all conversations from the registry HTTP endpoint and seed the local store.
   *  This ensures pre-existing conversations (before Codex connected) are visible to polling. */
  private async syncRegistryToLocalStore(): Promise<void> {
    try {
      const entries = await this.registry.listChannelConversations();
      for (const entry of entries) {
        const snapshot = await this.registry.getChannelConversation(entry.conversationId);
        if (snapshot) {
          this.channelRuntime.seedFromSnapshot(snapshot.messages);
        }
      }
      console.error(`[MCP] Synced ${entries.length} conversation(s) from registry to local store`);
    } catch {
      // Registry may not be ready yet; WebSocket events will populate the store.
    }
  }

  private startInboxPolling(): void {
    this.stopInboxPolling();
    if (this.clientProfile.deliveryMode !== "inbox-first") return;
    if (!this.inboxFirstConfig.autoPollInbox) return;

    this.inboxPollTimer = setInterval(() => {
      void this.surfacePendingInboxMessages();
    }, this.inboxFirstConfig.pollIntervalMs);
  }

  private stopInboxPolling(): void {
    if (this.inboxPollTimer) {
      clearInterval(this.inboxPollTimer);
      this.inboxPollTimer = null;
    }
    this.surfacedInboxMessageIds.clear();
  }

  private async surfacePendingInboxMessages(): Promise<void> {
    if (this.clientProfile.deliveryMode !== "inbox-first") return;

    const pending = this.conversationService.listPendingSnapshots();
    await this.surfaceSnapshotMessages(pending, "pending");

    if (this.inboxFirstConfig.pollActiveConversations) {
      const allUnsurfaced = this.conversationService.listUnsurfacedSnapshots(this.surfacedInboxMessageIds);
      const pendingIds = new Set(pending.map((s) => s.conversation.conversationId));
      const activeOnly = allUnsurfaced.filter((s) => !pendingIds.has(s.conversation.conversationId));
      await this.surfaceSnapshotMessages(activeOnly, "active");
    }
  }

  private async surfaceSnapshotMessages(
    snapshots: import("../client/conversation-service.js").ConversationSnapshot[],
    source: "pending" | "active",
  ): Promise<void> {
    const totalCount = snapshots.length;

    // Collect all unsurfaced messages first, then mark them all at once.
    // This prevents sending N notifications for N accumulated messages —
    // instead we send at most ONE notification per poll cycle.
    const unsurfaced: Array<{
      snapshot: import("../client/conversation-service.js").ConversationSnapshot;
      message: ChannelMessage;
    }> = [];

    for (const snapshot of snapshots) {
      const messagesToCheck = source === "pending" ? snapshot.pendingMessages : snapshot.messages;
      for (const message of messagesToCheck) {
        if (message.fromAgentId === this.clientAgentId) continue;
        if (this.surfacedInboxMessageIds.has(message.messageId)) continue;
        unsurfaced.push({ snapshot, message });
      }
    }

    if (unsurfaced.length === 0) return;

    // Mark ALL as surfaced before sending so future polls don't re-fire them.
    for (const { message } of unsurfaced) {
      this.surfacedInboxMessageIds.add(message.messageId);
    }

    if (unsurfaced.length === 1) {
      // Single new message: send detailed notification.
      const { snapshot, message } = unsurfaced[0];
      const notification = this.buildSurfacedInboxNotification(snapshot, message, totalCount, source)
        ?? {
            method: "notifications/message",
            params: {
              level: "info",
              logger: "agent-bridge.channel",
              data: {
                content: source === "pending"
                  ? `New pending channel conversation from ${message.fromAgentName ?? message.fromAgentId}. ` +
                    `Open channel_inbox and reply. Preview: ${message.content.slice(0, 220)}${message.content.length > 220 ? "…" : ""}`
                  : `New message in active conversation from ${message.fromAgentName ?? message.fromAgentId}. ` +
                    `Open channel_inbox to view. Preview: ${message.content.slice(0, 220)}${message.content.length > 220 ? "…" : ""}`,
                meta: {
                  type: source === "pending" ? "inbox-poll" : "inbox-poll-active",
                  conversationId: snapshot.conversation.conversationId,
                  messageId: message.messageId,
                  fromAgentId: message.fromAgentId,
                  fromAgentName: message.fromAgentName,
                  taskId: message.taskId,
                  pendingCount: totalCount,
                },
              },
            },
          };
      await this.server.server.notification(notification).catch(() => {
        // Ignore visibility failures; polling continues.
      });
    } else {
      // Multiple new messages: send ONE aggregated notification to avoid flooding the client.
      const notification = {
        method: "notifications/message",
        params: {
          level: "info",
          logger: "agent-bridge.channel",
          data: {
            content: source === "pending"
              ? `You have ${totalCount} pending channel conversation(s) (${unsurfaced.length} new). Open channel_inbox to inspect and reply.`
              : `${unsurfaced.length} new messages across active conversations. Open channel_inbox to view.`,
            meta: {
              type: source === "pending" ? "inbox-poll" : "inbox-poll-active",
              pendingCount: totalCount,
              newMessageCount: unsurfaced.length,
            },
          },
        },
      };
      await this.server.server.notification(notification).catch(() => {
        // Ignore visibility failures; polling continues.
      });
    }
  }

  private buildInboundChannelNotification(message: ChannelMessage) {
    if (this.clientProfile.id === "codex") {
      return this.codexProxy.buildChannelNotification(message);
    }
    if (this.clientProfile.id === "gemini") {
      return this.geminiProxy.buildChannelNotification(message);
    }
    return this.clientProfile.mapChannelMessage(message);
  }

  private buildSurfacedInboxNotification(
    snapshot: import("../client/conversation-service.js").ConversationSnapshot,
    message: ChannelMessage,
    totalCount: number,
    source: "pending" | "active",
  ) {
    if (this.clientProfile.id === "codex") {
      return source === "pending"
        ? this.codexProxy.buildPendingReminder(snapshot, message, totalCount)
        : this.codexProxy.buildActiveConversationNotification(snapshot, message);
    }
    if (this.clientProfile.id === "gemini") {
      return source === "pending"
        ? this.geminiProxy.buildPendingReminder(snapshot, message, totalCount)
        : this.geminiProxy.buildActiveConversationNotification(snapshot, message);
    }
    return null;
  }

  private buildTaskRequestNotification(message: AgentMessage) {
    if (this.clientProfile.id === "codex") {
      return this.codexProxy.buildTaskRequestNotification(message);
    }
    if (this.clientProfile.id === "gemini") {
      return this.geminiProxy.buildTaskRequestNotification(message);
    }
    return this.clientProfile.mapTaskRequestMessage(message);
  }

  private async postChannelAck(ack: {
    conversationId: string;
    messageId: string;
    state: "queued" | "delivered_to_bridge" | "displayed_to_client" | "answered" | "failed";
    actorId: string;
    actorType: "registry" | "bridge" | "client" | "agent";
    detail?: string;
  }): Promise<void> {
    try {
      await this.channelRuntime.acknowledgeMessage({
        conversationId: ack.conversationId,
        messageId: ack.messageId,
        state: ack.state,
        actorId: ack.actorId,
        actorType: ack.actorType,
        detail: ack.detail,
      });
    } catch {
      // Ignore ack failures; conversation can continue without them.
    }
  }

  /** Send a message via WS relay and wait for response */
  private sendMessageViaWs(targetAgentId: string, message: string, options?: {
    skillId?: string;
    input?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.registryWs || this.registryWs.readyState !== WebSocket.OPEN) {
        reject(new Error("No WebSocket connection to registry"));
        return;
      }

      const taskId = randomUUID();
      const timeoutMs = options?.timeoutMs ?? 60_000;

      const timer = setTimeout(() => {
        this.pendingResponses.delete(taskId);
        reject(new Error(`WS message timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingResponses.set(taskId, { resolve, reject, timer });

      const agentMessage: AgentMessage = {
        fromAgentId: this.clientAgentId ?? "mcp-adapter",
        toAgentId: targetAgentId,
        taskId,
        type: "task.request",
        payload: {
          message,
          skillId: options?.skillId,
          input: options?.input,
        },
        timestamp: Date.now(),
      };

      this.registryWs.send(JSON.stringify({
        type: "agent.message",
        timestamp: new Date().toISOString(),
        data: agentMessage,
      }));
    });
  }

  // ── Infrastructure bootstrap ───────────────────────────────────────────────

  private async ensureInfrastructure(): Promise<RegistryEntry[]> {
    const registryAvailable = await this.registry.isAvailable();

    if (!registryAvailable) {
      if (!this.options.auto) {
        console.error("[MCP] Registry not available. Start with: agent-bridge registry start");
        return [];
      }

      // Auto-start embedded registry
      console.error("[MCP] No registry found — starting embedded registry on :4999");
      this.embeddedRegistry = new RegistryServer();
      await this.embeddedRegistry.start();
    }

    // Check if any agents are registered
    let agents = await this.registry.listAgents({ healthy: true });

    // Check if there's already an agent for THIS project specifically
    const hasAgentForThisProject = agents.some(
      (a) => a.entryType !== "client" && a.projectPath === this.options.projectPath
    );

    if (!hasAgentForThisProject && this.options.auto) {
      // Auto-start a local agent for the current project
      console.error(`[MCP] No agent for ${this.options.projectPath} — starting one`);
      this.embeddedAgent = new AgentServer({
        projectPath: this.options.projectPath,
        registryUrl: this.options.registryUrl,
        useClaudeCode: this.options.useClaudeCode,
      });
      await this.embeddedAgent.start();

      // Poll until an agent with skills registers (max 5s)
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 500));
        agents = await this.registry.listAgents({ healthy: true });
        if (agents.some(a => a.entryType !== "client")) break;
      }
    }

    return agents;
  }

  // ── Client detection ───────────────────────────────────────────────────────

  private setupClientDetection(): void {
    // Access the underlying MCP SDK Server to hook into the initialize handshake
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerServer = (this.server as unknown as { server: any }).server;
    if (!innerServer) return;

    innerServer.oninitialized = async () => {
      try {
        if (this.clientAgentId || this.clientActivating) {
          console.error(`[MCP] Ignoring duplicate oninitialized`);
          return;
        }

        const clientVersion = innerServer.getClientVersion?.();
        if (!clientVersion?.name) return;

        this.clientActivating = true;

        const clientName: string = clientVersion.name;
        const version: string = clientVersion.version ?? "unknown";
        this.clientProfile = this.profileResolver.resolve({ clientName });
        this.inboxFirstConfig = resolveInboxFirstClientConfig(this.bridgeConfig, this.clientProfile.id);

        // Resolve real project path from client's workspace roots (MCP roots protocol)
        let realProjectPath = this.options.projectPath;
        let realProjectName = basename(this.options.projectPath);
        const capabilities = innerServer.getClientCapabilities?.();
        if (capabilities?.roots) {
          try {
            const rootsResult = await innerServer.listRoots();
            if (rootsResult.roots?.length > 0) {
              const firstRoot = rootsResult.roots[0];
              if (firstRoot.uri.startsWith("file://")) {
                realProjectPath = decodeURIComponent(new URL(firstRoot.uri).pathname);
                realProjectName = firstRoot.name || basename(realProjectPath);
              }
            }
          } catch {
            // fall back to configured projectPath
          }
        }

        this.clientAgentId = this.buildStableClientAgentId(clientName, realProjectPath);

        const registration = {
          agentId: this.clientAgentId,
          name: realProjectName,
          url: "",
          wsUrl: "",
          port: 0,
          projectPath: realProjectPath,
          projectName: realProjectName,
          projectType: "unknown",
          card: {
            name: realProjectName,
            description: `AI client: ${clientName} v${version} — ${realProjectName}`,
            url: "",
            version,
            capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
            defaultInputModes: ["text"],
            defaultOutputModes: ["text"],
            skills: [],
          },
          registeredAt: Date.now(),
          entryType: "client" as const,
          clientInfo: { clientName, clientVersion: version },
        };

        await this.channelRuntime.activateClient(registration);
        const tmuxBinding = await detectCurrentTmuxBinding();
        if (clientName.toLowerCase().includes("codex")) {
          const existing = readCurrentCodexSession(realProjectPath);
          writeCurrentCodexSession(realProjectPath, {
            clientAgentId: this.clientAgentId,
            clientName,
            projectPath: realProjectPath,
            registeredAt: Date.now(),
            sidecarPid: existing?.sidecarPid,
            tmuxPane: tmuxBinding?.pane ?? existing?.tmuxPane,
            tmuxSessionName: tmuxBinding?.sessionName ?? existing?.tmuxSessionName,
            tmuxWindowName: tmuxBinding?.windowName ?? existing?.tmuxWindowName,
            tmuxCurrentCommand: tmuxBinding?.currentCommand ?? existing?.tmuxCurrentCommand,
          });
        }
        if (clientName.toLowerCase().includes("gemini")) {
          const existing = readCurrentGeminiSession(realProjectPath);
          writeCurrentGeminiSession(realProjectPath, {
            clientAgentId: this.clientAgentId,
            clientName,
            projectPath: realProjectPath,
            registeredAt: Date.now(),
            sidecarPid: existing?.sidecarPid,
            tmuxPane: tmuxBinding?.pane ?? existing?.tmuxPane,
            tmuxSessionName: tmuxBinding?.sessionName ?? existing?.tmuxSessionName,
            tmuxWindowName: tmuxBinding?.windowName ?? existing?.tmuxWindowName,
            tmuxCurrentCommand: tmuxBinding?.currentCommand ?? existing?.tmuxCurrentCommand,
          });
        }
        await this.syncRegistryToLocalStore();
        this.startInboxPolling();
        this.startCodexSidecarIfNeeded(realProjectPath, clientName);
        this.startGeminiSidecarIfNeeded(realProjectPath, clientName);
        console.error(`[MCP] Registered client: ${realProjectName} (${clientName} v${version})`);

        const cleanup = async () => {
          this.stopCodexSidecar();
          this.stopGeminiSidecar();
          this.stopInboxPolling();
          await this.channelRuntime.deactivateClient();
          if (clientName.toLowerCase().includes("codex")) {
            clearCurrentCodexSession(realProjectPath, this.clientAgentId ?? undefined);
          }
          if (clientName.toLowerCase().includes("gemini")) {
            clearCurrentGeminiSession(realProjectPath, this.clientAgentId ?? undefined);
          }
          this.clientAgentId = null;
          // Stop embedded agent so it deregisters from registry
          if (this.embeddedAgent) {
            try { await this.embeddedAgent.stop(); } catch { /* ignore */ }
            this.embeddedAgent = null;
          }
          if (this.embeddedRegistry) {
            try { await this.embeddedRegistry.stop(); } catch { /* ignore */ }
            this.embeddedRegistry = null;
          }
        };

        process.once("SIGINT", cleanup);
        process.once("SIGTERM", cleanup);
        process.once("beforeExit", cleanup);
      } catch (err) {
        this.clientActivating = false;
        console.error("[MCP] Failed to register client:", err);
      }
    };
  }

  private buildStableClientAgentId(clientName: string, projectPath: string): string {
    const digest = createHash("sha1")
      .update(`${clientName}\n${projectPath}`)
      .digest("hex")
      .slice(0, 12);
    return `client-${clientName}-${digest}`;
  }

  /**
   * Generates a deterministic conversation ID for a bilateral session between two agents.
   * The ID is symmetric (same result regardless of which side initiates) and stable
   * across restarts, so both agents can always find their shared conversation thread.
   */
  private buildDeterministicConversationId(agentIdA: string, agentIdB: string): string {
    const sorted = [agentIdA, agentIdB].sort().join("\n");
    const hex = createHash("sha1").update(sorted).digest("hex");
    // Format as UUID v4-shaped string for compatibility
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private startCodexSidecarIfNeeded(projectPath: string, clientName: string): void {
    if (!this.options.codexSidecar) return;
    const normalized = clientName.toLowerCase();
    if (!normalized.includes("codex")) return;
    if (this.codexSidecarProcess || !this.clientAgentId) return;

    const launch = this.buildSidecarLaunch(projectPath);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      cwd: projectPath,
      env: process.env,
    });
    child.unref();
    this.codexSidecarProcess = child;
    const existing = readCurrentCodexSession(projectPath);
    writeCurrentCodexSession(projectPath, {
      clientAgentId: this.clientAgentId,
      clientName,
      projectPath,
      registeredAt: Date.now(),
      sidecarPid: child.pid,
      tmuxPane: existing?.tmuxPane ?? process.env["TMUX_PANE"],
      tmuxSessionName: existing?.tmuxSessionName,
      tmuxWindowName: existing?.tmuxWindowName,
      tmuxCurrentCommand: existing?.tmuxCurrentCommand,
    });
    console.error(`[MCP] Detached Codex sidecar started for ${this.clientAgentId} (pid=${child.pid ?? "unknown"})`);
  }

  private stopCodexSidecar(): void {
    if (!this.codexSidecarProcess) return;
    try {
      this.codexSidecarProcess.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.codexSidecarProcess = null;
  }

  private startGeminiSidecarIfNeeded(projectPath: string, clientName: string): void {
    if (!this.options.geminiSidecar) return;
    if (!clientName.toLowerCase().includes("gemini")) return;
    if (this.geminiSidecarProcess || !this.clientAgentId) return;

    const launch = this.buildGeminiSidecarLaunch(projectPath);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      cwd: projectPath,
      env: process.env,
    });
    child.unref();
    this.geminiSidecarProcess = child;
    const existing = readCurrentGeminiSession(projectPath);
    writeCurrentGeminiSession(projectPath, {
      clientAgentId: this.clientAgentId,
      clientName,
      projectPath,
      registeredAt: Date.now(),
      sidecarPid: child.pid,
      tmuxPane: existing?.tmuxPane ?? process.env["TMUX_PANE"],
      tmuxSessionName: existing?.tmuxSessionName,
      tmuxWindowName: existing?.tmuxWindowName,
      tmuxCurrentCommand: existing?.tmuxCurrentCommand,
    });
    console.error(`[MCP] Detached Gemini sidecar started for ${this.clientAgentId} (pid=${child.pid ?? "unknown"})`);
  }

  private stopGeminiSidecar(): void {
    if (!this.geminiSidecarProcess) return;
    try {
      this.geminiSidecarProcess.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.geminiSidecarProcess = null;
  }

  private buildGeminiSidecarLaunch(projectPath: string): { command: string; args: string[] } {
    const baseArgs = [
      "gemini",
      "tmux-sidecar",
      "--project",
      projectPath,
      "--registry-url",
      this.options.registryUrl,
      "--poll-interval-ms",
      String(this.options.geminiSidecarPollIntervalMs),
      "--retry-interval-ms",
      String(this.options.geminiSidecarRetryIntervalMs),
    ];

    const tmuxPane = process.env["TMUX_PANE"];
    if (tmuxPane) {
      baseArgs.push("--tmux-pane", tmuxPane);
    }

    const entry = process.argv[1] ?? "";
    if (entry.endsWith(".ts")) {
      return {
        command: "pnpm",
        args: ["exec", "tsx", resolve(entry), ...baseArgs],
      };
    }

    return {
      command: process.execPath,
      args: [resolve(entry), ...baseArgs],
    };
  }

  private buildSidecarLaunch(projectPath: string): { command: string; args: string[] } {
    const baseArgs = [
      "codex",
      "tmux-sidecar",
      "--project",
      projectPath,
      "--registry-url",
      this.options.registryUrl,
      "--poll-interval-ms",
      String(this.options.codexSidecarPollIntervalMs),
      "--retry-interval-ms",
      String(this.options.codexSidecarRetryIntervalMs),
    ];

    const tmuxPane = process.env["TMUX_PANE"];
    if (tmuxPane) {
      baseArgs.push("--tmux-pane", tmuxPane);
    }

    const entry = process.argv[1] ?? "";
    if (entry.endsWith(".ts")) {
      return {
        command: "pnpm",
        args: ["exec", "tsx", resolve(entry), ...baseArgs],
      };
    }

    return {
      command: process.execPath,
      args: [resolve(entry), ...baseArgs],
    };
  }

  // ── Meta-tools ─────────────────────────────────────────────────────────────

  private registerMetaTools(): void {

    this.server.registerTool(
      "list_agents",
      {
        description:
          "List all agents connected to agent-bridge. Shows each agent's project path, type, " +
          "health status, and available skills. Use this first to discover what you can work with. " +
          "By default, only shows agents with skills (excludes passive client entries).",
        inputSchema: {
          skill: z.string().optional().describe("Filter agents with this skill (e.g. 'endpoint-find')"),
          project: z.string().optional().describe("Filter by project name or path substring"),
          healthyOnly: z.boolean().optional().describe("Only show healthy agents (default: true)"),
          includeClients: z.boolean().optional().describe("Include passive client entries without skills (default: false)"),
        },
      },
      async ({ skill, project, healthyOnly = true, includeClients = false }) => {
        try {
          let agents = await this.registry.listAgents({
            skill,
            project,
            healthy: healthyOnly ? true : undefined,
          });
          if (!includeClients) {
            agents = agents.filter((a) => a.entryType !== "client" || a.card.skills.length > 0);
          }
          return { content: [{ type: "text" as const, text: formatAgentsSummary(agents) }] };
        } catch {
          return {
            content: [{ type: "text" as const, text: "Registry not reachable at localhost:4999." }],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      "agent_health",
      {
        description: "Check if a specific agent is alive and responding. Returns status, project info, and available skills.",
        inputSchema: {
          agentId: z.string().describe("Agent ID (from list_agents) or agent name"),
        },
      },
      async ({ agentId }) => {
        try {
          const entry = await this.resolveAgent(agentId);
          const client = new A2AClient(entry.url);
          const health = await client.health();
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                agent: entry.name,
                agentId: entry.agentId,
                status: health.status ?? "alive",
                projectPath: entry.projectPath,
                projectType: entry.projectType,
                skills: entry.card.skills.map((s) => s.id),
                url: entry.url,
              }, null, 2),
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Agent unreachable: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      "ask_agent",
      {
        description:
          "Send a message or task to any connected agent. " +
          "Tries WebSocket relay first for real-time communication, falls back to HTTP. " +
          "Optionally specify a skillId to invoke a specific capability. " +
          "Use this only with runnable agents that expose skills/HTTP endpoints. " +
          "For passive client sessions discovered in list_agents, use message_client_session instead.",
        inputSchema: {
          agentId: z.string().describe("Target agent ID or name (from list_agents)"),
          message: z.string().describe("The message, question, or task to send"),
          skillId: z.string().optional().describe("Skill to invoke on the target agent (e.g. 'claude-execute')"),
          input: z.preprocess(
            (v) => (typeof v === "string" ? JSON.parse(v) : v),
            z.record(z.unknown()).optional()
          ).describe("Direct skill input as JSON (overrides message parsing)"),
          timeout: z.coerce.number().optional().describe("Timeout in ms (default: 60000, max: 300000)"),
          waitForResponse: z.boolean().optional().describe("Wait for response via WS (default: true)"),
        },
      },
      async ({ agentId, message, skillId, input, timeout, waitForResponse = true }) => {
        try {
          const entry = await this.resolveAgent(agentId);
          if (entry.entryType === "client" && entry.card.skills.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: `Target "${entry.name}" is a passive client session, not a runnable A2A agent. Use message_client_session with clientId=${entry.agentId}.`,
              }],
              isError: true,
            };
          }
          const taskId = randomUUID();
          await this.emitTraceEvent({ agentId: entry.agentId, agentName: entry.name, taskId, state: "submitted", skillId });

          // Resolve timeout: explicit > skill-based default > standard default
          const wsTimeoutMs = timeout ?? (skillId === "claude-execute" ? 300_000 : 60_000);

          // Try WS relay first for real-time terminal-to-terminal communication
          if (waitForResponse && this.registryWs?.readyState === WebSocket.OPEN) {
            try {
              const result = await this.sendMessageViaWs(entry.agentId, message, { skillId, input, timeoutMs: wsTimeoutMs });
              await this.emitTraceEvent({ agentId: entry.agentId, agentName: entry.name, taskId, state: "completed", skillId });
              const rpcResult = result as { result?: unknown; error?: { message: string } };
              if (rpcResult?.error) {
                return { content: [{ type: "text" as const, text: `Agent error: ${rpcResult.error.message}` }], isError: true };
              }
              const task = rpcResult?.result ?? result;
              return { content: [{ type: "text" as const, text: extractTaskResponse(task) }] };
            } catch {
              console.error("[MCP] WS relay failed for ask_agent, falling back to HTTP");
            }
          }

          // Guard: no URL means client entry with no HTTP server
          if (!entry.url) {
            return {
              content: [{
                type: "text" as const,
                text: `Agent "${entry.name}" has no HTTP endpoint (it's a client entry). ` +
                      `WS relay unavailable or timed out. Target an agent with skills instead.`,
              }],
              isError: true,
            };
          }

          // Fallback: HTTP direct
          const client = new A2AClient(entry.url);
          const task = await client.sendTask({
            message: { role: "user", parts: [{ type: "text", text: message }] },
            metadata: {
              ...(skillId ? { skillId } : {}),
              ...(input ? { input } : {}),
            },
          });
          await this.emitTraceEvent({ agentId: entry.agentId, agentName: entry.name, taskId, state: "completed", skillId });
          return { content: [{ type: "text" as const, text: extractTaskResponse(task) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      "mark_expired_channel_conversations",
      {
        description:
          "Mark locally expired channel conversations as failed. " +
          "This updates the local conversation layer and emits failed acknowledgements for the expired last messages.",
        inputSchema: {
          limit: z.coerce.number().optional().describe("Maximum number of expired conversations to mark (default: 10)"),
        },
      },
      async ({ limit = 10 }) => {
        try {
          const updated = await this.conversationService.markExpiredAsFailed(limit);
          if (updated.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No expired channel conversations were marked as failed." }],
            };
          }

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(updated.map((snapshot) => ({
                conversationId: snapshot.conversation.conversationId,
                status: snapshot.status,
                lastAckState: snapshot.conversation.lastAckState,
                lastMessageId: snapshot.conversation.lastMessageId,
              })), null, 2),
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      "delete_channel_conversation",
      {
        description:
          "Suppress a channel conversation through the registry so every client sees the same result. " +
          "This also removes it from the local runtime store.",
        inputSchema: {
          conversationId: z.string().describe("Conversation ID to suppress"),
        },
      },
      async ({ conversationId }) => {
        try {
          const deleted = await this.registry.suppressChannelConversation(conversationId);
          if (deleted) {
            this.conversationService.deleteConversation(conversationId);
          }
          return {
            content: [{
              type: "text" as const,
              text: deleted
                ? `Suppressed conversation ${conversationId} in the registry and local runtime`
                : `Conversation ${conversationId} was not found in the registry.`,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      "channel_inbox",
      {
        description:
          "Inspect the current client's channel conversations. " +
          "Useful for debugging the channel MVP and seeing pending or recent conversations tracked locally by the runtime. " +
          "For Codex and other inbox-first clients, this is the primary way to review inbound channel messages.",
        inputSchema: {
          expiredOnly: z.boolean().optional().describe("Show only locally expired conversations awaiting reply"),
          pendingOnly: z.boolean().optional().describe("Show only conversations awaiting reply (default: true)"),
          limit: z.coerce.number().optional().describe("Maximum number of conversations to show when pendingOnly=false (default: 10)"),
          includeMessages: z.boolean().optional().describe("Include message history for each pending conversation"),
        },
      },
      async ({ expiredOnly = false, pendingOnly = true, limit = 10, includeMessages = true }) => {
        try {
          // Always sync from registry so inbox shows current state even when WS was interrupted
          await this.syncRegistryToLocalStore();

          const conversations = expiredOnly
            ? this.conversationService.listExpiredSnapshots(limit)
            : pendingOnly
              ? this.conversationService.listPendingSnapshots()
              : this.conversationService.listRecentSnapshots(limit);
          if (conversations.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: expiredOnly
                  ? "No expired channel conversations for this client."
                  : pendingOnly
                    ? "No pending channel conversations for this client."
                    : "No tracked channel conversations for this client.",
              }],
            };
          }

          const payload = conversations.map((snapshot) => {
            // Find the latest inbound pending message (not from self) to surface reply context
            const latestInbound = snapshot.pendingMessages
              .filter((m) => m.fromAgentId !== this.clientAgentId)
              .at(-1);

            return {
              conversationId: snapshot.conversation.conversationId,
              status: snapshot.status,
              awaitingReply: snapshot.conversation.awaitingReply,
              lastAckState: snapshot.conversation.lastAckState,
              lastUpdatedAt: snapshot.lastUpdatedAt,
              expiresAt: snapshot.lastMessage?.expiresAt,
              lastMessagePreview: snapshot.lastMessage?.content.slice(0, 160),
              // Exact parameters to pass to the reply tool — no guesswork needed
              replyWith: latestInbound
                ? {
                    agentId: latestInbound.fromAgentId,
                    conversationId: snapshot.conversation.conversationId,
                    replyTo: latestInbound.messageId,
                  }
                : undefined,
              pendingMessages: snapshot.pendingMessages.map((message) => ({
                messageId: message.messageId,
                fromAgentId: message.fromAgentId,
                fromAgentName: message.fromAgentName,
                toAgentId: message.toAgentId,
                expiresAt: message.expiresAt,
                content: message.content,
              })),
              messages: includeMessages
                ? snapshot.messages.map((message) => ({
                    messageId: message.messageId,
                    fromAgentId: message.fromAgentId,
                    fromAgentName: message.fromAgentName,
                    toAgentId: message.toAgentId,
                    replyTo: message.replyTo,
                    content: message.content,
                    createdAt: message.createdAt,
                  }))
                : undefined,
            };
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      "message_client_session",
      {
        description:
          "Send a channel message to a specific client session. " +
          "Use this for Codex, Claude, Gemini, or dashboard conversations over channels. " +
          "Do not use ask_agent for passive client entries. " +
          "When the target client is Codex, expect replies to be handled through channel_inbox plus reply rather than automatic push rendering.",
        inputSchema: {
          clientId: z.string().optional().describe("Target client session agentId"),
          project: z.string().optional().describe("Project name or path used to resolve the target client session"),
          message: z.string().describe("Message to send over the channel"),
          conversationId: z.string().optional().describe("Conversation ID to continue"),
          replyTo: z.string().optional().describe("Message ID this replies to"),
          taskId: z.string().optional().describe("Optional task ID associated with the channel conversation"),
          expectsResponse: z.boolean().optional().describe("Whether the sender expects a reply"),
          timeoutMs: z.coerce.number().optional().describe("How long the receiver may take to reply before the message expires"),
        },
      },
      async (input) => this.handleMessageClientSession(input)
    );

    this.server.registerTool(
      "message_claude_client",
      {
        description:
          "Compatibility alias for message_client_session. " +
          "Prefer message_client_session for new integrations.",
        inputSchema: {
          clientId: z.string().optional().describe("Target client session agentId"),
          project: z.string().optional().describe("Project name or path used to resolve the target client session"),
          message: z.string().describe("Message to send over the channel"),
          conversationId: z.string().optional().describe("Conversation ID to continue"),
          replyTo: z.string().optional().describe("Message ID this replies to"),
          taskId: z.string().optional().describe("Optional task ID associated with the channel conversation"),
          expectsResponse: z.boolean().optional().describe("Whether the sender expects a reply"),
          timeoutMs: z.coerce.number().optional().describe("How long the receiver may take to reply before the message expires"),
        },
      },
      async (input) => this.handleMessageClientSession(input)
    );

    this.server.registerTool(
      "reply",
      {
        description:
          "Reply to a pending channel message from another agent. " +
          "Always use the exact values from channel_inbox's replyWith field: " +
          "agentId, conversationId, and replyTo. " +
          "Do NOT guess or omit these — all three are required for correct routing. " +
          "Example: if channel_inbox returns replyWith={agentId:'X', conversationId:'Y', replyTo:'Z'}, " +
          "pass all three exactly as-is.",
        inputSchema: {
          agentId: z.string().describe("fromAgentId of the message you are replying to (from channel_inbox replyWith.agentId)"),
          message: z.string().describe("Your reply message"),
          conversationId: z.string().describe("conversationId from channel_inbox replyWith.conversationId"),
          replyTo: z.string().describe("messageId of the message you are replying to (from channel_inbox replyWith.replyTo)"),
          taskId: z.string().optional().describe("Task ID associated with the conversation (optional)"),
          skillId: z.string().optional().describe("Optional fallback skill when using task invocation"),
        },
      },
      async ({ agentId, message, conversationId, replyTo, taskId, skillId }) => {
        try {
          // Sync store before reply so resolveReplyContext has fresh data
          await this.syncRegistryToLocalStore();

          const replyResult = await this.conversationService.replyAndAcknowledge({
            agentId,
            conversationId,
            replyTo,
            taskId,
            kind: "chat",
            message,
            meta: skillId ? { skillId } : undefined,
            requiresAck: true,
            expectsResponse: false,
            acknowledgementState: "answered",
            acknowledgementDetail: "Reply sent from Claude channel",
          });

          const resolvedAgentId =
            replyResult.reply.message.toAgentId ??
            agentId ??
            replyResult.reply.resolvedContext?.toAgentId;

          if (!resolvedAgentId) {
            return {
              content: [{
                type: "text" as const,
                text: "reply needs agentId, conversationId, and replyTo — use the replyWith field from channel_inbox.",
              }],
              isError: true,
            };
          }

          let recipientName = resolvedAgentId;
          try {
            const entry = await this.resolveAgent(resolvedAgentId);
            recipientName = `${entry.name} (${entry.clientInfo?.clientName ?? resolvedAgentId})`;
          } catch { /* resolveAgent is best-effort */ }

          const channelMessage = replyResult.reply.message;
          return {
            content: [{
              type: "text" as const,
              text: [
                `Reply sent to: ${recipientName}`,
                `  toAgentId:      ${resolvedAgentId}`,
                `  conversationId: ${channelMessage.conversationId}`,
                `  messageId:      ${channelMessage.messageId}`,
                `  replyTo:        ${replyTo}`,
              ].join("\n"),
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );

  }

  // ── Per-agent skill tools ──────────────────────────────────────────────────

  private registerAgentSkillTools(agents: RegistryEntry[]): void {
    for (const agent of agents) {
      if (this.agentToolMap.has(agent.agentId)) continue;
      this.addAgentTools(agent);
    }
  }

  private addAgentTools(agent: RegistryEntry): void {
    if (this.agentToolMap.has(agent.agentId)) return;
    if (agent.entryType === "client" || agent.card.skills.length === 0) return;

    // Use agentId suffix to avoid name collisions between agents with same name
    const prefix = `${toolPrefix(agent.name)}_${agent.agentId.slice(0, 4)}`;
    const tools: RegisteredTool[] = [];

    for (const skill of agent.card.skills) {
      const toolName = `${prefix}__${skill.id.replace(/-/g, "_")}`;
      const registeredTool = this.server.registerTool(
        toolName,
        {
          description:
            `[${agent.name}] ${skill.description}\n` +
            `Project: ${agent.projectPath} (${agent.projectType})`,
          inputSchema: this.getSkillInputSchema(skill.id),
        },
        async (input) => {
          try {
            // Try WS relay first for real-time communication
            const skillWsTimeoutMs = skill.id === "claude-execute" ? 300_000 : 60_000;
            if (this.registryWs?.readyState === WebSocket.OPEN) {
              try {
                const result = await this.sendMessageViaWs(agent.agentId, JSON.stringify(input), { skillId: skill.id, input: input as Record<string, unknown>, timeoutMs: skillWsTimeoutMs });
                const rpcResult = result as { result?: unknown; error?: { message: string } };
                if (rpcResult?.error) {
                  return { content: [{ type: "text" as const, text: `Agent error: ${rpcResult.error.message}` }], isError: true };
                }
                const task = rpcResult?.result ?? result;
                const taskObj = task as { artifacts?: Array<{ parts: Array<{ type: string; data?: unknown }> }> };
                const artifact = taskObj?.artifacts?.[0];
                if (artifact?.parts[0]?.type === "data") {
                  return { content: [{ type: "text" as const, text: JSON.stringify(artifact.parts[0].data, null, 2) }] };
                }
                return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
              } catch {
                // WS failed — fallback to HTTP
              }
            }
            // HTTP fallback
            const client = new A2AClient(agent.url);
            const taskId = randomUUID();
            await this.emitTraceEvent({ agentId: agent.agentId, agentName: agent.name, taskId, state: "submitted", skillId: skill.id });
            const task = await client.sendTask({
              message: { role: "user", parts: [{ type: "text", text: JSON.stringify(input) }] },
              metadata: { skillId: skill.id, input },
            });
            await this.emitTraceEvent({ agentId: agent.agentId, agentName: agent.name, taskId, state: "completed", skillId: skill.id });
            const artifact = task.artifacts[0];
            const data = artifact?.parts[0];
            if (data?.type === "data") {
              return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify(task.status) }] };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
      );
      tools.push(registeredTool);
    }

    this.agentToolMap.set(agent.agentId, tools);
    console.error(`[MCP] Added tools for agent: ${agent.name} (${tools.length} tools)`);
  }

  private removeAgentTools(agentId: string): void {
    const tools = this.agentToolMap.get(agentId);
    if (!tools) return;
    for (const tool of tools) {
      try { tool.remove(); } catch { /* ignore if already removed */ }
    }
    this.agentToolMap.delete(agentId);
    console.error(`[MCP] Removed tools for agent: ${agentId}`);
  }

  private setAgentToolsEnabled(agentId: string, enabled: boolean): void {
    const tools = this.agentToolMap.get(agentId);
    if (!tools) return;
    for (const tool of tools) {
      try { enabled ? tool.enable() : tool.disable(); } catch { /* ignore */ }
    }
  }

  private getSkillInputSchema(skillId: string): Record<string, z.ZodTypeAny> {
    switch (skillId) {
      case "file-search":
        return {
          pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/**/*.json')"),
          rootDir: z.string().optional().describe("Root directory (defaults to project root)"),
          ignore: z.array(z.string()).optional().describe("Patterns to ignore"),
          limit: z.number().optional().describe("Max number of results (default: 100)"),
        };
      case "endpoint-find":
        return {
          rootDir: z.string().optional().describe("Root directory to scan"),
          framework: z
            .enum(["auto", "express", "nestjs", "fastapi", "spring", "hono", "fastify"])
            .optional()
            .describe("Framework hint (default: auto)"),
          query: z.string().optional().describe("Filter endpoints by path/method keyword"),
        };
      case "code-query":
        return {
          query: z.string().describe("Text or regex pattern to search"),
          fileGlob: z.string().optional().describe("Limit search to files matching this glob"),
          rootDir: z.string().optional().describe("Root directory to search"),
          maxResults: z.number().optional().describe("Maximum number of results (default: 50)"),
          caseSensitive: z.boolean().optional().describe("Case-sensitive search (default: false)"),
        };
      case "prompt-execute":
        return {
          template: z.string().describe("Prompt template with {{variable}} placeholders"),
          variables: z.record(z.string()).optional().describe("Variables to inject"),
          context: z.string().optional().describe("Additional context to prepend"),
          instruction: z.string().optional().describe("What the agent receiving this prompt should do with it"),
        };
      case "claude-execute":
        return {
          prompt: z.string().describe("The task or question for Claude"),
          allowedTools: z.array(z.string()).optional()
            .describe("Allowed tools: Read, Glob, Grep (default: all three)"),
        };
      case "shell-execute":
        return {
          command: z.string().describe("Shell command to execute"),
          timeout: z.number().optional().describe("Timeout in ms (default: 30000, max: 120000)"),
          cwd: z.string().optional().describe("Working directory relative to project root"),
        };
      case "notify-claude":
        return {
          content: z.string().describe("Message content to push to the Claude terminal"),
          targetClientId: z.string().optional().describe("Target Claude client agentId"),
          targetProject: z.string().optional().describe("Project path or name used to resolve the target Claude client"),
          conversationId: z.string().optional().describe("Conversation ID to continue"),
          replyTo: z.string().optional().describe("Message ID this message replies to"),
          requiresAck: z.boolean().optional().describe("Whether to request delivery acknowledgements"),
          expectsResponse: z.boolean().optional().describe("Whether this message expects a reply"),
          responseTimeoutMs: z.number().optional().describe("How long to wait for a reply before expiring"),
          meta: z.record(z.unknown()).optional().describe("Optional metadata to attach"),
        };
      case "code-review":
      case "run-tests":
      case "run-script":
      case "docker-build":
        return {
          query: z.string().describe("What to do or ask"),
        };
      default:
        return {
          message: z.string().describe("Input message for the skill"),
        };
    }
  }

  // ── Resources ──────────────────────────────────────────────────────────────

  private registerResources(_agents: RegistryEntry[]): void {
    this.server.registerResource(
      "connected-agents",
      "agents://connected",
      {
        description: "All agents connected to agent-bridge with their capabilities",
        mimeType: "application/json",
      },
      async () => {
        const liveAgents = await this.registry.listAgents({ healthy: true });
        return {
          contents: [{
            uri: "agents://connected",
            mimeType: "application/json",
            text: JSON.stringify(
              liveAgents.map((a) => ({
                agentId: a.agentId,
                name: a.name,
                projectPath: a.projectPath,
                projectType: a.projectType,
                port: a.port,
                healthy: a.healthy,
                skills: a.card.skills.map((s) => ({ id: s.id, description: s.description })),
              })),
              null,
              2
            ),
          }],
        };
      }
    );

    const template = new ResourceTemplate("agents://{agentId}/card", { list: undefined });
    this.server.registerResource(
      "agent-card",
      template,
      { description: "A2A Agent Card for a connected agent", mimeType: "application/json" },
      async (uri, { agentId }) => {
        const all = await this.registry.listAgents();
        const agent = all.find((a) => a.agentId === agentId || a.name === agentId);
        if (!agent) throw new Error(`Agent "${agentId}" not found`);
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(agent.card, null, 2) }],
        };
      }
    );
  }

  // ── Prompts ────────────────────────────────────────────────────────────────

  private registerPrompts(agents: RegistryEntry[]): void {
    this.server.registerPrompt(
      "agent_bridge_status",
      {
        description: "Shows which agents are connected and what each can do. Run this first.",
        argsSchema: {},
      },
      async () => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: [
              "## agent-bridge — Connected Agents\n",
              formatAgentsSummary(agents),
              "\n## Available MCP Tools\n",
              "- **list_agents** — Refresh and list all connected agents",
              "- **agent_health** — Check if a specific agent is alive",
              "- **ask_agent** — Send any message/task to a runnable A2A agent",
              "- **message_client_session** — Send a channel message to a passive client session",
              "- **message_claude_client** — Compatibility alias for Claude-oriented workflows",
              "- **channel_inbox** — Refresh your local inbox of pending or recent channel conversations",
              "- **reply** — Reply to an incoming channel event from an agent",
              "- **project_info** — Get project metadata from an agent",
              "- **project_files** — List files in a remote project",
              agents.length > 0
                ? `\n## Per-Agent Tools\n${agents.flatMap((a) =>
                    a.card.skills.map((s) => `- **${toolPrefix(a.name)}_${a.agentId.slice(0, 4)}__${s.id.replace(/-/g, "_")}** — ${s.description}`)
                  ).join("\n")}`
                : "",
            ].filter(Boolean).join("\n"),
          },
        }],
      })
    );
  }

  // ── Trace helpers ──────────────────────────────────────────────────────────

  private getClientDisplayName(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerServer = (this.server as unknown as { server: any }).server;
    return innerServer?.getClientVersion?.()?.name ?? "unknown";
  }

  private async emitTraceEvent(params: {
    agentId: string;
    agentName: string;
    taskId: string;
    state: string;
    skillId?: string;
  }): Promise<void> {
    if (!this.clientAgentId) return;
    const clientName = this.getClientDisplayName();
    try {
      await fetch(`${this.options.registryUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...params,
          timestamp: new Date().toISOString(),
          clientId: this.clientAgentId,
          clientName,
        }),
      });
    } catch { /* ignore */ }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async resolveAgent(agentId: string): Promise<RegistryEntry> {
    try {
      const entry = await this.registry.getAgent(agentId);
      // If it has a URL (real HTTP server), use it directly
      if (entry.url) return entry;
      // No URL — try to find another entry for same project that has a URL
      const all = await this.registry.listAgents();
      const withUrl = all.find((a) => a.url && a.projectPath === entry.projectPath);
      if (withUrl) return withUrl;
      return entry;
    } catch {
      const all = await this.registry.listAgents();
      const isMatch = (a: RegistryEntry) =>
        a.name.toLowerCase() === agentId.toLowerCase() ||
        a.agentId.startsWith(agentId) ||
        a.projectPath.toLowerCase().includes(agentId.toLowerCase());
      // Prefer entries with a URL (real agents with HTTP servers)
      const matchWithUrl = all.find((a) => a.url && isMatch(a));
      if (matchWithUrl) return matchWithUrl;
      // Fall back to any match (including client entries)
      const anyMatch = all.find(isMatch);
      if (!anyMatch) throw new Error(`Agent "${agentId}" not found. Use list_agents to see available agents.`);
      return anyMatch;
    }
  }

  private async resolveClientSession(params: { clientId?: string; project?: string }): Promise<RegistryEntry> {
    const all = await this.registry.listAgents();
    const clients = all.filter((entry) => entry.entryType === "client");

    if (params.clientId) {
      const clientId = params.clientId;
      const entry = clients.find((entry) => entry.agentId === clientId || entry.agentId.startsWith(clientId));
      if (entry) return entry;

      // Exact ID not found — client may have restarted with a new ID.
      // Fall back to matching by client name extracted from the agentId prefix (e.g. "codex" from "client-codex-...").
      const namePart = clientId.replace(/^client-/, "").replace(/-[^-]+$/, "").toLowerCase();
      const fallback = clients.find((e) =>
        e.clientInfo?.clientName?.toLowerCase().includes(namePart) ||
        e.agentId.toLowerCase().includes(namePart)
      );
      if (!fallback) {
        throw new Error(`Client session "${params.clientId}" not found. Use list_agents with includeClients=true.`);
      }
      console.error(`[MCP] Client "${params.clientId}" not found; using fallback match: ${fallback.agentId}`);
      return fallback;
    }

    const project = params.project?.toLowerCase();
    const matches = clients.filter((entry) =>
      project != null &&
      (entry.projectPath.toLowerCase().includes(project) || entry.projectName.toLowerCase().includes(project))
    );

    if (matches.length === 0) {
      throw new Error(
        `No client session found for project "${params.project}". Use list_agents with includeClients=true.`
      );
    }

    if (matches.length > 1) {
      const ids = matches.map((entry) => `${entry.agentId} (${entry.clientInfo?.clientName ?? "unknown"})`).join(", ");
      throw new Error(
        `Project "${params.project}" matches multiple client sessions. Use clientId explicitly. Matches: ${ids}`
      );
    }

    return matches[0]!;
  }

  private async handleMessageClientSession(params: {
    clientId?: string;
    project?: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
    taskId?: string;
    expectsResponse?: boolean;
    timeoutMs?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    try {
      const client = await this.resolveClientSession({ clientId: params.clientId, project: params.project });
      const expectsResponse = params.expectsResponse ?? true;
      const expiresAt = expectsResponse ? Date.now() + (params.timeoutMs ?? 300_000) : undefined;
      // Use a deterministic conversationId so both sides always share the same thread.
      // This lets the recipient reply without needing to look up the conversationId.
      const fromAgentId = this.clientAgentId ?? "mcp-adapter";
      const deterministicConversationId = this.buildDeterministicConversationId(fromAgentId, client.agentId);
      const resolvedConversationId = params.conversationId ?? deterministicConversationId;

      const snapshot = params.replyTo || params.conversationId
        ? (await this.conversationService.replyAndAcknowledge({
            agentId: client.agentId,
            conversationId: resolvedConversationId,
            replyTo: params.replyTo,
            taskId: params.taskId,
            message: params.message,
            kind: "chat",
            requiresAck: true,
            expectsResponse,
            expiresAt,
            meta: {
              targetClientId: client.agentId,
              targetProject: client.projectPath,
              targetClientName: client.clientInfo?.clientName,
            },
          })).snapshot
        : await this.conversationService.startConversation({
            toAgentId: client.agentId,
            taskId: params.taskId,
            message: params.message,
            kind: "chat",
            expectsResponse,
            requiresAck: true,
            expiresAt,
            conversationId: resolvedConversationId,
            meta: {
              targetClientId: client.agentId,
              targetProject: client.projectPath,
              targetClientName: client.clientInfo?.clientName,
            },
          });
      const channelMessage = snapshot.messages[snapshot.messages.length - 1];
      const deliveryState = await this.conversationService.waitForAcknowledgement(
        channelMessage.conversationId,
        channelMessage.messageId,
      );
      const targetClientName = client.clientInfo?.clientName?.toLowerCase();
      const inboxFirst = targetClientName === "codex"
        || targetClientName === "codex-cli"
        || targetClientName === "gemini"
        || targetClientName === "gemini-cli";

      return {
        content: [{
          type: "text" as const,
          text: [
            `Channel message sent to ${client.name}`,
            `  toAgentId:      ${client.agentId}`,
            `  conversationId: ${channelMessage.conversationId}`,
            `  messageId:      ${channelMessage.messageId}`,
            `  deliveryState:  ${deliveryState ?? "pending"}`,
            inboxFirst
              ? "Target is inbox-first. To check for a reply use channel_inbox — the conversationId above is stable and deterministic for this pair."
              : "",
          ].filter(Boolean).join("\n"),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  // ── HTTP transport ─────────────────────────────────────────────────────────

  private async startHttpTransport(port: number, agents: RegistryEntry[]): Promise<void> {
    const { default: express } = await import("express");
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");

    const app = express();
    app.use(express.json());

    let transport: InstanceType<typeof SSEServerTransport> | null = null;

    app.get("/mcp", async (_req, res) => {
      transport = new SSEServerTransport("/mcp/message", res);
      await this.server.connect(transport);
    });

    app.post("/mcp/message", async (req, res) => {
      if (!transport) { res.status(400).json({ error: "No SSE connection" }); return; }
      await transport.handlePostMessage(req, res);
    });

    app.get("/", (_req, res) => {
      res.json({
        server: "agent-bridge MCP",
        agents: agents.length,
        endpoints: { sse: "/mcp", message: "/mcp/message" },
      });
    });

    await new Promise<void>((resolve) => app.listen(port, "localhost", () => resolve()));
    console.error(`[MCP] HTTP server at http://localhost:${port}/mcp`);
  }
}
