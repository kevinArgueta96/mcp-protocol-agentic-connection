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
import { BoundedIdSet } from "../client/bounded-id-set.js";
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
    return "No agents currently connected. Start one with: open-agent-bridge start <project-path>";
  }
  const runnableAgents = agents.filter((a) => a.entryType !== "client" || a.card.skills.length > 0);
  // Exclude internal infrastructure from the visible client list:
  //   - dashboard UI (agentId: client-dashboard-ui)
  //   - bridge daemons (clientVersion: app-server-bridge) — implementation detail, not a send target
  const clients = agents.filter(
    (a) =>
      a.entryType === "client" &&
      a.card.skills.length === 0 &&
      a.agentId !== "client-dashboard-ui" &&
      a.clientInfo?.clientVersion !== "app-server-bridge",
  );

  return [
    `${agents.length} entry(ies) connected via open-agent-bridge:\n`,
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
  private surfacedInboxMessageIds = new BoundedIdSet(5_000);
  private pendingPreInitMessages: ChannelMessage[] = [];
  private syncInFlight = false;
  /** AgentIds of bridge daemons (`client-{codex,gemini}-bridge-*`) that share
   *  this MCP client's project path. Codex/Gemini sessions register two entries
   *  — the bridge and the inner MCP client — and the auto-redirect rewrites
   *  outbound `toAgentId` to the bridge. The inner client must still recognize
   *  those rewritten messages as locally addressable so they surface in
   *  `channel_inbox(pendingOnly=true)`. Refreshed on every registry sync. */
  private siblingBridgeAgentIds: Set<string> = new Set();
  /** Periodic sync as defense-in-depth: every 5 min the adapter pulls the
   *  registry's snapshot to recover any messages that slipped through the live
   *  WS path (e.g. half-open socket the runtime hasn't yet detected). */
  private periodicSyncTimer: NodeJS.Timeout | null = null;
  /** One-shot delayed sync triggered after a permanent push failure. Bounds the
   *  worst-case "lost message" window to ~15 s instead of waiting for the next
   *  ws.open or scheduled sync. */
  private delayedSyncTimer: NodeJS.Timeout | null = null;

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
      { name: "open-agent-bridge", version: "0.1.0" },
      {
        capabilities: { experimental: { "claude/channel": {} } },
        instructions:
          "You are connected to open-agent-bridge, a multi-agent communication hub.\n\n" +
          "WORKFLOW:\n" +
          "  • Discover targets:  list_agents(includeClients=true)\n" +
          "  • Start a thread:    message_client_session(clientId|project, message)\n" +
          "  • See pending:       channel_inbox(pendingOnly=true) — every entry has a `replyWith` block\n" +
          "  • Respond:           reply(agentId, conversationId, replyTo, message) — copy fields from replyWith verbatim\n\n" +
          "DELIVERY MODES (you do NOT need to manage routing — the adapter handles it):\n" +
          "  • Claude Code peers: receive your message as an immediate <channel> push event.\n" +
          "  • Codex / Gemini peers: each session has TWO registry entries — a bridge daemon\n" +
          "    (`client-{codex,gemini}-bridge-*`) and an inner MCP client\n" +
          "    (`client-{codex,gemini}-mcp-client-*`). The bridge injects the message as a new\n" +
          "    turn in the CLI; the inner client also surfaces it in channel_inbox(pendingOnly=true)\n" +
          "    so the agent can poll for pending work. Reply via the inner client's session.\n" +
          "  • The adapter AUTO-REDIRECTS any inner-client agentId to its sibling bridge for\n" +
          "    delivery, so copy `replyWith.agentId` from channel_inbox or `from_agent` from the\n" +
          "    <channel> event verbatim — no manual lookup needed.\n\n" +
          "VERIFYING DELIVERY:\n" +
          "  • `delivered_to_bridge` means the daemon accepted the message but the peer LLM may\n" +
          "    not have seen it yet (mid-turn or daemon offline). Wait for `displayed_to_client`\n" +
          "    or `answered`. If stuck on `delivered_to_bridge` for >30s, call channel_inbox to\n" +
          "    re-inspect; if still no reply, the bridge is offline — surface this to the user.",
      },
    );
    this.setupChannelRuntime();
  }

  async start(transport: "stdio" | "http" = "stdio", httpPort = 6000): Promise<void> {
    // ── 1. Ensure registry is running ─────────────────────────────────────
    await this.ensureInfrastructure();

    // ── 1b. Register shutdown cleanup for embedded registry ───────────────
    const shutdownEmbedded = async () => {
      this.clearSyncTimers();
      if (this.embeddedRegistry) {
        try { await this.embeddedRegistry.stop(); } catch { /* ignore */ }
        this.embeddedRegistry = null;
      }
    };
    process.once("SIGINT", () => void shutdownEmbedded().then(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdownEmbedded().then(() => process.exit(0)));

    // ── 1c. Connect WS to registry for channel events ─────────────────────
    this.channelRuntime.connect();

    // ── 1d. Periodic re-sync (defense-in-depth) ───────────────────────────
    this.startPeriodicSync();

    // ── 2. Register tools ─────────────────────────────────────────────────
    this.registerMetaTools();

    // ── 3. Setup client detection (must be before connect) ─────────────────
    this.setupClientDetection();

    // ── 4. Connect transport ───────────────────────────────────────────────
    if (transport === "stdio") {
      const stdioTransport = new StdioServerTransport();
      await this.server.connect(stdioTransport);
      console.error("[MCP] open-agent-bridge ready.");
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
      if (
        !this.clientProfile.acceptsChannelMessage(channelMessage, this.clientAgentId, {
          siblingBridgeAgentIds: this.siblingBridgeAgentIds,
        })
      )
        return;
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

    void this.tryPushNotification(notification, channelMessage).then((success) => {
      if (success) {
        // Mark surfaced ONLY after the push succeeded — otherwise a permanent push
        // failure would silently swallow the message (sync would skip it as "surfaced"
        // and the client would never see it).
        this.surfacedInboxMessageIds.add(channelMessage.messageId);
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
    maxRetries = 5,
  ): Promise<boolean> {
    // Capped exponential backoff: 250, 500, 1000, 2000, 4000 ms (capped at 5s).
    // Five attempts buys ~7.5s of resilience against transient stdio backpressure
    // without blocking the event loop for too long.
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.server.server.notification(notification);
        return true;
      } catch (err) {
        console.error(
          `[MCP] Notification push failed (attempt ${attempt}/${maxRetries}) for message ${channelMessage.messageId}: ${String(err)}`,
        );
        if (attempt < maxRetries) {
          const delay = Math.min(250 * Math.pow(2, attempt - 1), 5_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    console.error(
      `[MCP] Notification push permanently failed for message ${channelMessage.messageId}. ` +
        `Will retry via delayed sync; message stays in inbox: ${channelMessage.conversationId}`,
    );
    // Bound the worst-case "lost message" window: schedule a one-shot sync that
    // will pick this message up again because we never marked it surfaced.
    this.scheduleDelayedSync(15_000);
    return false;
  }

  // ── Sync timers ────────────────────────────────────────────────────────────

  private startPeriodicSync(periodMs = 5 * 60_000): void {
    if (this.periodicSyncTimer) return;
    this.periodicSyncTimer = setInterval(() => {
      if (!this.clientAgentId) return; // pre-init: nothing to sync against
      void this.syncRegistryToLocalStore();
    }, periodMs);
  }

  private scheduleDelayedSync(delayMs: number): void {
    if (this.delayedSyncTimer) return; // already scheduled — coalesce bursts
    this.delayedSyncTimer = setTimeout(() => {
      this.delayedSyncTimer = null;
      void this.syncRegistryToLocalStore();
    }, delayMs);
  }

  private clearSyncTimers(): void {
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }
    if (this.delayedSyncTimer) {
      clearTimeout(this.delayedSyncTimer);
      this.delayedSyncTimer = null;
    }
  }

  private drainPendingPreInitMessages(): void {
    const pending = this.pendingPreInitMessages;
    this.pendingPreInitMessages = [];
    for (const msg of pending) {
      if (
        !this.clientProfile.acceptsChannelMessage(msg, this.clientAgentId, {
          siblingBridgeAgentIds: this.siblingBridgeAgentIds,
        })
      )
        continue;
      if (this.surfacedInboxMessageIds.has(msg.messageId)) continue;
      this.deliverChannelMessage(msg);
    }
  }

  /** Repopulate `siblingBridgeAgentIds` with the bridge daemon entries that
   *  share this MCP client's project path. Idempotent and best-effort: failure
   *  to reach the registry leaves the previous snapshot in place. */
  private async refreshSiblingBridgeAgentIds(): Promise<void> {
    try {
      const all = await this.registry.listAgents();
      const myProject = this.options.projectPath;
      const next = new Set<string>();
      for (const e of all) {
        if (e.entryType !== "client") continue;
        if (e.projectPath !== myProject) continue;
        if (e.agentId === this.clientAgentId) continue; // exclude self
        const cv = e.clientInfo?.clientVersion ?? "";
        if (cv === "app-server-bridge" || cv === "acp-bridge") {
          next.add(e.agentId);
        }
      }
      this.siblingBridgeAgentIds = next;
    } catch (err: unknown) {
      console.error(
        "[MCP] sibling bridge refresh failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Fetch all conversations from the registry HTTP endpoint and seed the local store.
   *  Also replays any unsurfaced messages after WS reconnection.
   *
   *  IMPORTANT: A message is considered "already handled" if the registry has any ack
   *  for it in a terminal state (`displayed_to_client`, `answered`, `failed`). Without
   *  this check, restarting the client would re-surface every prior message because
   *  `surfacedInboxMessageIds` is in-memory and lost across process restarts. */
  private async syncRegistryToLocalStore(): Promise<void> {
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    try {
      // Refresh sibling bridge ids first so the acceptsChannelMessage filter
      // below recognizes auto-redirected messages targeting our sibling bridge.
      await this.refreshSiblingBridgeAgentIds();

      const entries = await this.registry.listChannelConversations();
      const unsurfacedMessages: ChannelMessage[] = [];
      const TERMINAL_ACK_STATES = new Set(["displayed_to_client", "answered", "failed"]);
      for (const entry of entries) {
        const snapshot = await this.registry.getChannelConversation(entry.conversationId);
        if (!snapshot) continue;

        // Replay both messages AND acknowledgements so lastAckState/awaitingReply
        // reflect the registry's authoritative view after restart.
        this.channelRuntime.seedFromSnapshot(snapshot.messages, snapshot.acknowledgements);

        // Build a set of messageIds that the registry already saw reach a terminal
        // state. These should never be re-surfaced as "new" inbox items.
        const handledIds = new Set<string>();
        for (const ack of snapshot.acknowledgements ?? []) {
          if (TERMINAL_ACK_STATES.has(ack.state)) {
            handledIds.add(ack.messageId);
          }
        }

        for (const msg of snapshot.messages) {
          if (msg.fromAgentId === this.clientAgentId) continue;
          if (this.surfacedInboxMessageIds.has(msg.messageId)) continue;
          if (handledIds.has(msg.messageId)) {
            // Mark in-memory too so any concurrent live delivery dedupes correctly.
            this.surfacedInboxMessageIds.add(msg.messageId);
            continue;
          }
          if (
            !this.clientProfile.acceptsChannelMessage(msg, this.clientAgentId, {
              siblingBridgeAgentIds: this.siblingBridgeAgentIds,
            })
          )
            continue;
          if (msg.expiresAt && msg.expiresAt <= Date.now()) continue;
          unsurfacedMessages.push(msg);
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
        console.error("[MCP] Registry not available. Start with: open-agent-bridge registry start");
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
        // Keep options in sync so downstream lookups (e.g. sibling bridge ids)
        // match the project the client actually identified itself with via the
        // MCP roots protocol, not the cwd-derived default from the constructor.
        this.options.projectPath = realProjectPath;

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
          this.clearSyncTimers();
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
          "List all agents and client sessions connected to open-agent-bridge. " +
          "Returns each entry's agentId, project path, type, health status, and available skills. " +
          "WORKFLOW: call this first to discover targets before using message_client_session. " +
          "IMPORTANT: to see Codex/Gemini/Claude bridges (client sessions without HTTP skills), " +
          "pass includeClients=true — they are hidden by default.",
        inputSchema: {
          skill: z.string().optional().describe("Filter agents with this skill (e.g. 'endpoint-find')"),
          project: z.string().optional().describe("Filter by project name or path substring"),
          healthyOnly: z.boolean().optional().describe("Only show healthy agents (default: true)"),
          includeClients: z.boolean().optional().describe("Include client sessions (Codex/Gemini/Claude bridges) that have no HTTP skills (default: false). Set true when looking for a session to message."),
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
          "Check this agent's channel inbox for pending inbound messages from other agents. " +
          "Returns conversations with a 'replyWith' field — pass those exact values to the reply tool. " +
          "WORKFLOW: (1) call channel_inbox to see pending messages, " +
          "(2) read the replyWith field of each pending conversation, " +
          "(3) call reply(replyWith.agentId, replyWith.conversationId, replyWith.replyTo, yourMessage). " +
          "Syncs automatically from the registry before returning so the view is always current.",
        inputSchema: {
          expiredOnly: z.boolean().optional().describe("Show only locally expired conversations awaiting reply"),
          pendingOnly: z.boolean().optional().describe("Show only conversations awaiting reply (default: true)"),
          limit: z.coerce.number().optional().describe("Maximum number of conversations to show when pendingOnly=false (default: 10)"),
          includeMessages: z.boolean().optional().describe("Include full message history for each pending conversation (default: true)"),
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

          // Prefetch the agents list once and build a (projectPath → bridge) index so
          // we can resolve `replyWith.agentId` to the bridge agentId for Codex/Gemini
          // peers without doing N HTTP lookups inside the conversation loop.
          let bridgeByProject = new Map<string, RegistryEntry>();
          let agentById = new Map<string, RegistryEntry>();
          try {
            const allAgents = await this.registry.listAgents();
            for (const entry of allAgents) {
              agentById.set(entry.agentId, entry);
              const cv = entry.clientInfo?.clientVersion;
              if (cv === "app-server-bridge" || cv === "acp-bridge") {
                bridgeByProject.set(entry.projectPath, entry);
              }
            }
          } catch {
            // best-effort — fall through with empty maps; replyWith just keeps the raw fromAgentId
          }
          const resolveReplyAgentId = (rawAgentId: string): string => {
            const entry = agentById.get(rawAgentId);
            if (!entry) return rawAgentId;
            const cv = entry.clientInfo?.clientVersion ?? "";
            const cn = (entry.clientInfo?.clientName ?? "").toLowerCase();
            const isBridge = cv === "app-server-bridge" || cv === "acp-bridge";
            const isCodexOrGemini = cn.includes("codex") || cn.includes("gemini");
            if (!isCodexOrGemini || isBridge) return rawAgentId;
            return bridgeByProject.get(entry.projectPath)?.agentId ?? rawAgentId;
          };

          const payload = conversations.map((snapshot) => {
            // Find the latest inbound pending message (not from self) to surface reply context
            const latestInbound = snapshot.pendingMessages
              .filter((m) => m.fromAgentId !== this.clientAgentId)
              .at(-1);

            const routedReplyAgentId = latestInbound
              ? resolveReplyAgentId(latestInbound.fromAgentId)
              : undefined;

            return {
              conversationId: snapshot.conversation.conversationId,
              status: snapshot.status,
              awaitingReply: snapshot.conversation.awaitingReply,
              lastAckState: snapshot.conversation.lastAckState,
              lastUpdatedAt: snapshot.lastUpdatedAt,
              expiresAt: snapshot.lastMessage?.expiresAt,
              lastMessagePreview: snapshot.lastMessage?.content.slice(0, 160),
              // Exact parameters to pass to the reply tool — no guesswork needed.
              // For Codex/Gemini peers, `agentId` is already the bridge so the message
              // is delivered as a turn prompt. The original sender's fromAgentId is
              // preserved in `originalFromAgentId` for traceability.
              replyWith: latestInbound
                ? {
                    agentId: routedReplyAgentId!,
                    conversationId: snapshot.conversation.conversationId,
                    replyTo: latestInbound.messageId,
                    ...(routedReplyAgentId !== latestInbound.fromAgentId
                      ? { originalFromAgentId: latestInbound.fromAgentId }
                      : {}),
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
          "Initiate or continue a channel message thread with a client session (Claude Code, Codex, Gemini). " +
          "USE THIS when you want to proactively send a message or task to another agent. " +
          "DO NOT USE THIS to reply to a pending inbound message — use the reply tool for that instead. " +
          "\n\nWORKFLOW: (1) call list_agents(includeClients=true) to find the target's agentId, " +
          "(2) call message_client_session(clientId=<agentId>, message=<text>). " +
          "Target resolution order when clientId is not provided: " +
          "(a) conversationId participant lookup, (b) project name/path match; " +
          "when a project has multiple sessions, claude-code > gemini > codex (override with clientType). " +
          "\n\nDELIVERY SEMANTICS by target type:" +
          "\n  • Claude Code  → message arrives as an immediate <channel> push event." +
          "\n  • Codex/Gemini → message is injected as a new turn prompt by the bridge daemon." +
          "\n\nROUTING (you do NOT need to know which agentId is the bridge): if you pass an inner " +
          "Codex/Gemini MCP-client agentId (e.g. client-codex-mcp-client-* or client-gemini-mcp-client-*), " +
          "the adapter auto-redirects the message to the bridge for the same project. So you can copy " +
          "the `from_agent` of an inbound <channel> event or `replyWith.agentId` from channel_inbox " +
          "directly — routing is fixed transparently. This avoids the failure mode where a message " +
          "gets stuck at `delivered_to_bridge` because it was sent to a passive inner client.",
        inputSchema: {
          clientId: z.string().optional().describe("Exact agentId of the target client session (from list_agents). Most reliable — use this whenever possible."),
          project: z.string().optional().describe("Project name or path substring to resolve the target session. Use when you don't have the exact agentId."),
          clientType: z.string().optional().describe("Filter by client type when project matches multiple sessions: 'claude-code', 'codex', or 'gemini'. Ignored when clientId is set."),
          message: z.string().describe("Message text to send to the target session"),
          conversationId: z.string().optional().describe("Continue an existing conversation thread by reusing its ID. Leave blank to start a new thread."),
          replyTo: z.string().optional().describe("messageId to thread this message as a reply to (optional, for in-thread continuations)"),
          taskId: z.string().optional().describe("Optional task ID to associate with this conversation"),
          expectsResponse: z.boolean().optional().describe("Set true if you want to wait for the target to reply before this tool returns (default: true). Set false for fire-and-forget."),
          timeoutMs: z.coerce.number().optional().describe("How long to wait for a reply before reporting timeout (ms, default: 300000). Only used when expectsResponse=true."),
        },
      },
      async (input) => this.handleMessageClientSession(input)
    );

    this.server.registerTool(
      "reply",
      {
        description:
          "Reply to a pending inbound channel message from another agent and mark the thread as answered. " +
          "USE THIS when channel_inbox shows a pending message and you want to respond. " +
          "DO NOT USE THIS to initiate a new conversation — use message_client_session for that. " +
          "\n\nWORKFLOW: (1) call channel_inbox(pendingOnly=true), " +
          "(2) read the replyWith field of the conversation, " +
          "(3) call reply(agentId=replyWith.agentId, conversationId=replyWith.conversationId, replyTo=replyWith.replyTo, message=<your response>). " +
          "All three routing fields (agentId, conversationId, replyTo) are REQUIRED — copy them exactly from replyWith. " +
          "After calling this, the conversation is marked 'answered' and the sender receives your reply." +
          "\n\nROUTING: if `agentId` is a Codex/Gemini inner MCP client (which is what their `reply` tool " +
          "stamps as `fromAgentId` of their replies), the adapter auto-redirects to the project's bridge " +
          "daemon so the agent receives your reply as a turn prompt. You should always copy " +
          "`replyWith.agentId` verbatim — do NOT try to substitute a bridge agentId yourself.",
        inputSchema: {
          agentId: z.string().describe("The agentId of the sender you are replying to — MUST be replyWith.agentId from channel_inbox"),
          message: z.string().describe("Your reply text"),
          conversationId: z.string().describe("The conversation thread ID — MUST be replyWith.conversationId from channel_inbox"),
          replyTo: z.string().describe("The messageId you are replying to — MUST be replyWith.replyTo from channel_inbox"),
          taskId: z.string().optional().describe("Task ID associated with the conversation (optional)"),
          skillId: z.string().optional().describe("Optional fallback skill when using task invocation"),
        },
      },
      async ({ agentId, message, conversationId, replyTo, taskId, skillId }) => {
        try {
          // Sync store before reply so resolveReplyContext has fresh data
          await this.syncRegistryToLocalStore();

          // Auto-redirect: if `agentId` is a Codex/Gemini inner MCP client (which is
          // typically what `replyWith.agentId` returns when the inbound message came
          // from one of those agents), route the reply through the project's bridge
          // so the agent actually receives it as a turn prompt.
          let routedAgentId = agentId;
          try {
            const target = await this.resolveAgent(agentId);
            const deliverable = await this.resolveDeliverableTarget(target);
            routedAgentId = deliverable.agentId;
          } catch {
            // best-effort — keep the original agentId if lookup fails
          }

          const replyResult = await this.conversationService.replyAndAcknowledge({
            agentId: routedAgentId,
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

  /** Auto-redirect to a bridge daemon when the user-supplied target is a Codex/Gemini
   *  inner MCP client.
   *
   *  Why: Codex and Gemini sessions register TWO entries in the registry —
   *    1. the bridge daemon (`client-codex-bridge-*` / `client-gemini-bridge-*`),
   *    2. the inner MCP client running inside the agent (`client-codex-mcp-client-*` /
   *       `client-gemini-mcp-client-*`).
   *
   *  The bridge is the primary delivery path: it injects the content as a new turn
   *  prompt into the CLI, which is the only way Codex/Gemini will react to the
   *  message in real time. The inner client also stores the message locally so the
   *  agent can poll for it via `channel_inbox(pendingOnly=true)` — see
   *  `siblingBridgeAgentIds` and the `acceptsChannelMessage` profiles for how
   *  rewritten `toAgentId`s are recognized by the inner client.
   *
   *  This used to require the caller to know the bridge agentId. We now auto-redirect
   *  transparently so any inner-client agentId you pass (including the `fromAgentId`
   *  of an inbound reply or `replyWith.agentId` from channel_inbox) routes to the
   *  bridge of the same project.
   *
   *  Returns the original entry unchanged for Claude Code targets and for entries
   *  that are already a bridge. */
  private async resolveDeliverableTarget(target: RegistryEntry): Promise<RegistryEntry> {
    const clientVersion = target.clientInfo?.clientVersion ?? "";
    const clientName = (target.clientInfo?.clientName ?? "").toLowerCase();
    const isBridge = clientVersion === "app-server-bridge" || clientVersion === "acp-bridge";
    const isCodexOrGemini = clientName.includes("codex") || clientName.includes("gemini");

    if (!isCodexOrGemini || isBridge) return target;

    try {
      const all = await this.registry.listAgents();
      const bridge = all.find(
        (e) =>
          e.entryType === "client" &&
          e.projectPath === target.projectPath &&
          (e.clientInfo?.clientVersion === "app-server-bridge" ||
            e.clientInfo?.clientVersion === "acp-bridge"),
      );
      if (bridge) {
        console.error(
          `[MCP] Auto-redirect ${target.agentId.slice(0, 24)} (${clientName} inner client) ` +
            `→ ${bridge.agentId.slice(0, 24)} (bridge) — bridge injects the turn into the CLI.`,
        );
        return bridge;
      }
    } catch {
      // best-effort — fall through to the original target
    }
    return target;
  }

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
    // Exclude infrastructure entries: dashboard UI and bridge daemons are never valid send targets
    // (bridges are preferred internally via getPriority, but the dashboard should never receive channel messages)
    const clients = all.filter(
      (entry) =>
        entry.entryType === "client" &&
        entry.agentId !== "client-dashboard-ui",
    );

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
        // App-server bridge daemons always win — they inject messages as turns into the
        // running app-server, which is exactly what we want when multiple Codex sessions
        // coexist (e.g. bridge + TUI MCP client both registered for the same project).
        if (e.clientInfo?.clientVersion === "app-server-bridge") return -1;
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
      const resolved = await this.resolveClientSession({
        clientId: params.clientId,
        project: params.project,
        clientType: params.clientType,
        conversationId: params.conversationId,
      });
      // Codex/Gemini inner MCP clients can't act on push notifications; transparently
      // route the message through their bridge daemon instead.
      const client = await this.resolveDeliverableTarget(resolved);
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

      // Delivery wait strategy is client-specific:
      //
      // • Claude Code  → push delivery via `notifications/claude/channel` works reliably.
      //   Return fast (≤3s) so Claude Code is not blocked when the reply notification arrives.
      //   If we block Claude here, the incoming reply notification cannot be processed.
      //
      // • Codex/Gemini → `notifications/message` is only a log line; the AI agent does NOT
      //   react to it once the tool call has returned. The only way to surface the reply is
      //   in-band while the tool is still running. So we keep waiting for "answered".
      const isClaudeClient = this.clientProfile.id === "claude";

      // Phase 1 – always wait briefly for any delivery confirmation
      const deliveryAck = await this.conversationService.waitForAcknowledgement(
        channelMessage.conversationId,
        channelMessage.messageId,
        { timeoutMs: 3_000, states: ["delivered_to_bridge", "displayed_to_client", "answered", "failed"] },
      );

      // Phase 2 – for non-Claude clients that don't process push notifications, keep
      // waiting for the actual reply so we can return it inline.
      let deliveryState = deliveryAck;
      if (
        !isClaudeClient &&
        expectsResponse &&
        deliveryAck &&
        deliveryAck !== "answered" &&
        deliveryAck !== "failed"
      ) {
        const replyAck = await this.conversationService.waitForAcknowledgement(
          channelMessage.conversationId,
          channelMessage.messageId,
          {
            timeoutMs: Math.min(params.timeoutMs ?? 120_000, 120_000),
            pollIntervalMs: 500,
            states: ["answered", "failed"],
          },
        );
        if (replyAck) deliveryState = replyAck;
      }

      // If the agent answered, include the reply text inline
      let replyPreview = "";
      if (deliveryState === "answered") {
        const msgs = this.channelRuntime.listConversationMessages(channelMessage.conversationId);
        const reply = msgs.find((m) => m.replyTo === channelMessage.messageId);
        if (reply) replyPreview = `\n  reply:          ${reply.content.slice(0, 500)}`;
      }

      const statusNote =
        deliveryState === "answered"
          ? ""
          : deliveryState === "failed"
            ? "\n  Note: Delivery failed — the target bridge rejected the message."
            : isClaudeClient && deliveryState
              ? `\n  Note: Message delivered. The reply will arrive as a push notification.\n  To check now: call channel_inbox(pendingOnly=true)`
              : deliveryState
                ? `\n  Note: Message delivered but no reply within timeout.\n  Call channel_inbox(pendingOnly=true) to check for the reply.`
                : `\n  Note: No delivery confirmation yet. The target bridge may be offline.\n  To check: call channel_inbox(pendingOnly=true)`;

      return {
        content: [{
          type: "text" as const,
          text: [
            `Channel message sent to ${client.name}`,
            `  toAgentId:      ${client.agentId}`,
            `  conversationId: ${channelMessage.conversationId}`,
            `  messageId:      ${channelMessage.messageId}`,
            `  deliveryState:  ${deliveryState ?? "pending"}`,
          ].join("\n") + replyPreview + statusNote,
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
        server: "open-agent-bridge MCP",
        endpoints: { sse: "/mcp", message: "/mcp/message" },
      });
    });

    await new Promise<void>((resolve) => app.listen(port, "localhost", () => resolve()));
    console.error(`[MCP] HTTP server at http://localhost:${port}/mcp`);
  }
}
