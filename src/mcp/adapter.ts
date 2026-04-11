/**
 * MCP Adapter — Bridges the channel system as MCP tools for Claude Code
 *
 * AUTO MODE (default):
 *   If no registry is running at localhost:4999, starts one in-process.
 *   Also auto-starts a local agent for the current working directory.
 *   This means `mcp start` is fully self-contained — no manual setup needed.
 *
 * MANUAL MODE:
 *   Run registry + agents separately, then `mcp start` discovers them.
 *
 * Exposed tools (4):
 *   list_agents            — discover connected agents and client sessions
 *   message_client_session — send a channel message to a client session
 *   reply                  — reply to an incoming channel message
 *   channel_inbox          — inspect pending channel conversations
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { RegistryClient } from "../client/registry-client.js";
import { ChannelTransport } from "../client/channel-transport.js";
import { ChannelClientRuntime } from "../client/channel-client-runtime.js";
import { ConversationService } from "../client/conversation-service.js";
import { DefaultClientProfileResolver, type ClientBehaviorProfile } from "../client/client-profile-resolver.js";
import { RegistryServer } from "../registry/server.js";
import type { RegistryEntry, AgentMessage, ChannelMessage } from "../types/messages.js";

export interface McpAdapterOptions {
  registryUrl?: string;
  /** Auto-start registry if none found (default: true) */
  auto?: boolean;
  /** Project path used for client registration (default: cwd) */
  projectPath?: string;
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
  private clientProfile: ClientBehaviorProfile;
  private options: Required<McpAdapterOptions>;
  private clientAgentId: string | null = null;
  private clientActivating = false;
  private embeddedRegistry: RegistryServer | null = null;
  private surfacedInboxMessageIds = new Set<string>();
  private pendingPreInitMessages: ChannelMessage[] = [];
  private syncInFlight = false;

  constructor(options: McpAdapterOptions = {}) {
    this.options = {
      registryUrl: "http://localhost:4999",
      auto: true,
      projectPath: process.cwd(),
      ...options,
    };
    this.registry = new RegistryClient(this.options.registryUrl);
    this.channelTransport = new ChannelTransport({ registryUrl: this.options.registryUrl });
    this.channelRuntime = new ChannelClientRuntime({
      transport: this.channelTransport,
      reconnectDelayMs: 5_000,
      maxReconnectAttempts: 5,
    });
    this.conversationService = new ConversationService(this.channelRuntime);
    // Default to Claude profile until the real client identifies itself
    this.clientProfile = this.profileResolver.resolve({ clientName: "claude-code" });
    this.server = new McpServer(
      { name: "agent-bridge", version: "0.1.0" },
      {
        capabilities: { experimental: { "claude/channel": {} } },
        instructions:
          "You are connected to agent-bridge, a multi-agent communication hub. " +
          "Use list_agents to discover connected agents and client sessions. " +
          "Use message_client_session to send messages to other clients. " +
          "Use reply to respond to incoming channel messages. " +
          "Use channel_inbox to inspect pending conversations.",
      },
    );
    this.setupChannelRuntime();
  }

  async start(transport: "stdio" | "http" = "stdio", httpPort = 6000): Promise<void> {
    // ── 1. Ensure registry is running ─────────────────────────────────────
    await this.ensureInfrastructure();

    // ── 1b. Register shutdown cleanup for embedded registry ───────────────
    const shutdownEmbedded = async () => {
      if (this.embeddedRegistry) {
        try { await this.embeddedRegistry.stop(); } catch { /* ignore */ }
        this.embeddedRegistry = null;
      }
    };
    process.once("SIGINT", () => void shutdownEmbedded().then(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdownEmbedded().then(() => process.exit(0)));

    // ── 1c. Connect WS to registry for channel events ─────────────────────
    this.channelRuntime.connect();

    // ── 2. Register tools ─────────────────────────────────────────────────
    this.registerMetaTools();

    // ── 3. Setup client detection (must be before connect) ─────────────────
    this.setupClientDetection();

    // ── 4. Connect transport ───────────────────────────────────────────────
    if (transport === "stdio") {
      const stdioTransport = new StdioServerTransport();
      await this.server.connect(stdioTransport);
      console.error("[MCP] agent-bridge ready.");
    } else {
      await this.startHttpTransport(httpPort);
    }
  }

  // ── Channel runtime event wiring ──────────────────────────────────────────

  private setupChannelRuntime(): void {
    this.channelRuntime.on("ws.open", () => {
      console.error("[MCP] WebSocket connected to registry");
      // Refresh local store on every reconnect so channel_inbox stays accurate
      void this.syncRegistryToLocalStore();
    });

    this.channelRuntime.on("ws.close", () => {
      // nothing to clear — runtime manages its own WS state
    });

    this.channelRuntime.on("channel.message", (channelMessage) => {
      if (this.clientAgentId === null && channelMessage.toAgentId) {
        if (this.pendingPreInitMessages.length >= 100) {
          const dropped = this.pendingPreInitMessages.shift();
          console.error(`[MCP] Pre-init buffer full, dropping oldest message: ${dropped?.messageId}`);
        }
        this.pendingPreInitMessages.push(channelMessage);
        return;
      }
      // Broadcast messages (no toAgentId) are accepted by all profiles even with null selfAgentId
      if (!this.clientProfile.acceptsChannelMessage(channelMessage, this.clientAgentId)) return;
      this.deliverChannelMessage(channelMessage);
    });

    this.channelRuntime.on("legacy.notify", (notify) => {
      const notification = this.clientProfile.mapLegacyNotify(notify);
      if (!notification) return;
      void this.server.server.notification(notification);
    });

    this.channelRuntime.on("agent.message", (agentMsg) => {
      if (agentMsg.type === "task.request") {
        if (!this.clientAgentId || agentMsg.toAgentId !== this.clientAgentId) return;
        const notification = this.clientProfile.mapTaskRequestMessage(agentMsg as AgentMessage);
        if (!notification) return;
        void this.server.server.notification(notification);
      }
    });
  }

  private deliverChannelMessage(channelMessage: ChannelMessage): void {
    void this.postChannelAck({
      conversationId: channelMessage.conversationId,
      messageId: channelMessage.messageId,
      state: "delivered_to_bridge",
      actorId: this.clientAgentId ?? "mcp-adapter",
      actorType: "bridge",
      detail: "Message received by MCP bridge",
    });

    const notification = this.clientProfile.mapChannelMessage(channelMessage);
    if (!notification) return;
    this.surfacedInboxMessageIds.add(channelMessage.messageId);

    void this.tryPushNotification(notification, channelMessage).then((success) => {
      if (success) {
        void this.postChannelAck({
          conversationId: channelMessage.conversationId,
          messageId: channelMessage.messageId,
          state: "displayed_to_client",
          actorId: this.clientAgentId ?? "mcp-adapter",
          actorType: "bridge",
          detail: "Message forwarded to client channel",
        });
      }
    });
  }

  private async tryPushNotification(
    notification: { method: string; params: Record<string, unknown> },
    channelMessage: ChannelMessage,
    maxRetries = 2,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.server.server.notification(notification);
        return true;
      } catch (err) {
        console.error(
          `[MCP] Notification push failed (attempt ${attempt}/${maxRetries}) for message ${channelMessage.messageId}: ${String(err)}`,
        );
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
    }
    console.error(
      `[MCP] Notification push permanently failed for message ${channelMessage.messageId}. Message available in inbox: ${channelMessage.conversationId}`,
    );
    return false;
  }

  private drainPendingPreInitMessages(): void {
    const pending = this.pendingPreInitMessages;
    this.pendingPreInitMessages = [];
    for (const msg of pending) {
      if (!this.clientProfile.acceptsChannelMessage(msg, this.clientAgentId)) continue;
      if (this.surfacedInboxMessageIds.has(msg.messageId)) continue;
      this.deliverChannelMessage(msg);
    }
  }

  /** Fetch all conversations from the registry HTTP endpoint and seed the local store.
   *  Also replays any unsurfaced messages after WS reconnection. */
  private async syncRegistryToLocalStore(): Promise<void> {
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    try {
      const entries = await this.registry.listChannelConversations();
      const unsurfacedMessages: ChannelMessage[] = [];
      for (const entry of entries) {
        const snapshot = await this.registry.getChannelConversation(entry.conversationId);
        if (snapshot) {
          this.channelRuntime.seedFromSnapshot(snapshot.messages);
          for (const msg of snapshot.messages) {
            if (msg.fromAgentId === this.clientAgentId) continue;
            if (this.surfacedInboxMessageIds.has(msg.messageId)) continue;
            if (!this.clientProfile.acceptsChannelMessage(msg, this.clientAgentId)) continue;
            if (msg.expiresAt && msg.expiresAt <= Date.now()) continue;
            unsurfacedMessages.push(msg);
          }
        }
      }
      console.error(`[MCP] Synced ${entries.length} conversation(s) from registry to local store`);
      if (this.clientAgentId && this.clientProfile.deliveryMode === "push") {
        for (const msg of unsurfacedMessages) {
          this.deliverChannelMessage(msg);
        }
        if (unsurfacedMessages.length > 0) {
          console.error(`[MCP] Replayed ${unsurfacedMessages.length} unsurfaced message(s) after sync`);
        }
      }
    } catch (err: unknown) {
      console.error("[MCP] registry sync failed:", err instanceof Error ? err.message : err);
    } finally {
      this.syncInFlight = false;
    }
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
    } catch (err: unknown) {
      console.error("[MCP] channel ack failed:", err instanceof Error ? err.message : err);
    }
  }

  // ── Infrastructure bootstrap ───────────────────────────────────────────────

  private async ensureInfrastructure(): Promise<void> {
    const registryAvailable = await this.registry.isAvailable();

    if (!registryAvailable) {
      if (!this.options.auto) {
        console.error("[MCP] Registry not available. Start with: agent-bridge registry start");
        return;
      }

      // Auto-start embedded registry
      console.error("[MCP] No registry found — starting embedded registry on :4999");
      this.embeddedRegistry = new RegistryServer();
      await this.embeddedRegistry.start();
    }
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
        await this.syncRegistryToLocalStore();
        this.drainPendingPreInitMessages();
        console.error(`[MCP] Registered client: ${realProjectName} (${clientName} v${version})`);

        const cleanup = async () => {
          this.surfacedInboxMessageIds.clear();
          await this.channelRuntime.deactivateClient();
          this.clientAgentId = null;
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

  // ── Meta-tools ─────────────────────────────────────────────────────────────

  private registerMetaTools(): void {
    this.registerDiscoveryTools();
    this.registerConversationManagementTools();
    this.registerChannelMessagingTools();
  }

  /** list_agents */
  private registerDiscoveryTools(): void {
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
  }

  /** channel_inbox */
  private registerConversationManagementTools(): void {
    this.server.registerTool(
      "channel_inbox",
      {
        description:
          "Inspect the current client's channel conversations. " +
          "Useful for reviewing pending messages and conversations tracked locally by the runtime. " +
          "Always sync from registry before inspecting so the view is current.",
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
  }

  /** message_client_session, reply */
  private registerChannelMessagingTools(): void {
    this.server.registerTool(
      "message_client_session",
      {
        description:
          "Send a channel message to a specific client session (Claude Code, Codex, Gemini, or dashboard). " +
          "Resolves target in priority order: (1) exact clientId match, (2) conversationId participant lookup, " +
          "(3) project name/path match — when multiple sessions share the same project, claude-code is preferred " +
          "over gemini over codex automatically (use clientType to override). " +
          "Claude Code receives messages as immediate <channel> push events.",
        inputSchema: {
          clientId: z.string().optional().describe("Exact target client session agentId (most specific — skips all other resolution)"),
          project: z.string().optional().describe("Project name or path to resolve the target session; not required if conversationId is provided"),
          clientType: z.string().optional().describe("Filter by client type when project matches multiple sessions (e.g. 'claude-code', 'codex', 'gemini'). Ignored when clientId is set."),
          message: z.string().describe("Message to send over the channel"),
          conversationId: z.string().optional().describe("Conversation ID to continue; if neither clientId nor project is given, the target is resolved from this conversation's participants"),
          replyTo: z.string().optional().describe("Message ID this replies to"),
          taskId: z.string().optional().describe("Optional task ID associated with the channel conversation"),
          expectsResponse: z.boolean().optional().describe("Whether the sender expects a reply"),
          timeoutMs: z.coerce.number().optional().describe("How long the receiver may take to reply before the message expires (ms)"),
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

  private async resolveClientSession(params: { clientId?: string; project?: string; clientType?: string; conversationId?: string }): Promise<RegistryEntry> {
    const all = await this.registry.listAgents();
    const clients = all.filter((entry) => entry.entryType === "client");

    // 1. Direct clientId lookup (most specific — always wins)
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

    // 2. No clientId/project — try to resolve from an existing conversationId
    if (!params.project && params.conversationId) {
      const messages = this.channelRuntime.listConversationMessages(params.conversationId);
      // Find the other party: a message not from us
      const otherMsg = messages.find((m) => m.fromAgentId !== this.clientAgentId);
      if (otherMsg?.fromAgentId) {
        const match = clients.find((c) => c.agentId === otherMsg.fromAgentId);
        if (match) return match;
      }
      // Or: a message we sent, look at its toAgentId
      const ourMsg = messages.find((m) => m.fromAgentId === this.clientAgentId && m.toAgentId);
      if (ourMsg?.toAgentId) {
        const match = clients.find((c) => c.agentId === ourMsg.toAgentId);
        if (match) return match;
      }
    }

    if (!params.project) {
      throw new Error("Either clientId or project is required. Use list_agents with includeClients=true to see available clients.");
    }

    // 3. Project name/path matching
    const project = params.project.toLowerCase();
    let matches = clients.filter((entry) =>
      entry.projectPath.toLowerCase().includes(project) || entry.projectName.toLowerCase().includes(project)
    );

    if (matches.length === 0) {
      throw new Error(
        `No client session found for project "${params.project}". Use list_agents with includeClients=true.`
      );
    }

    // 4. Optionally filter by clientType (e.g. "claude-code", "codex", "gemini")
    if (params.clientType) {
      const typeFiltered = matches.filter((e) =>
        e.clientInfo?.clientName?.toLowerCase().includes(params.clientType!.toLowerCase())
      );
      if (typeFiltered.length > 0) matches = typeFiltered;
    }

    // 5. Multiple matches → prefer by priority instead of throwing an error
    if (matches.length > 1) {
      const CLIENT_PRIORITY = ["claude-code", "claude", "gemini-cli", "gemini", "codex-cli", "codex"];
      const getPriority = (e: RegistryEntry) => {
        const name = e.clientInfo?.clientName?.toLowerCase() ?? "";
        const idx = CLIENT_PRIORITY.findIndex((p) => name.includes(p));
        return idx === -1 ? CLIENT_PRIORITY.length : idx;
      };
      matches = [...matches].sort((a, b) => getPriority(a) - getPriority(b));
      const chosen = matches[0]!;
      const all_ids = matches.map((e) => `${e.agentId.slice(0, 16)} (${e.clientInfo?.clientName ?? "unknown"})`).join(", ");
      console.error(`[MCP] Multiple clients match "${params.project}": [${all_ids}]. Using: ${chosen.agentId} (${chosen.clientInfo?.clientName}). Use clientId or clientType to be explicit.`);
    }

    return matches[0]!;
  }

  private async handleMessageClientSession(params: {
    clientId?: string;
    project?: string;
    clientType?: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
    taskId?: string;
    expectsResponse?: boolean;
    timeoutMs?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    try {
      const client = await this.resolveClientSession({
        clientId: params.clientId,
        project: params.project,
        clientType: params.clientType,
        conversationId: params.conversationId,
      });
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

      return {
        content: [{
          type: "text" as const,
          text: [
            `Channel message sent to ${client.name}`,
            `  toAgentId:      ${client.agentId}`,
            `  conversationId: ${channelMessage.conversationId}`,
            `  messageId:      ${channelMessage.messageId}`,
            `  deliveryState:  ${deliveryState ?? "pending"}`,
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

  // ── HTTP transport ─────────────────────────────────────────────────────────

  private async startHttpTransport(port: number): Promise<void> {
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
        endpoints: { sse: "/mcp", message: "/mcp/message" },
      });
    });

    await new Promise<void>((resolve) => app.listen(port, "localhost", () => resolve()));
    console.error(`[MCP] HTTP server at http://localhost:${port}/mcp`);
  }
}
