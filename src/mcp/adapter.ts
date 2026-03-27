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
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { RegistryClient } from "../client/registry-client.js";
import { A2AClient } from "../client/a2a-client.js";
import { RegistryServer } from "../registry/server.js";
import { AgentServer } from "../agent/server.js";
import type { RegistryEntry, AgentMessage } from "../types/messages.js";
import type { Task, Part, Message } from "../types/a2a.js";
import { WebSocket } from "ws";

/** Convert meta values to strings — claude/channel spec requires Record<string, string> */
function stringifyMeta(meta?: Record<string, unknown>): Record<string, string> {
  if (!meta) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v != null) result[k] = String(v);
  }
  return result;
}

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
  return [
    `${agents.length} agent(s) connected via agent-bridge:\n`,
    ...agents.map((a) => {
      const skills = a.card.skills.map((s) => `    • ${s.id}: ${s.description}`).join("\n");
      return [
        `Agent: ${a.name}  [${a.agentId.slice(0, 8)}]`,
        `  Project: ${a.projectPath}`,
        `  Type:    ${a.projectType}${a.entryType === "client" ? " (client — no skills)" : ""}`,
        `  Status:  ${a.healthy ? "healthy" : "unhealthy"}`,
        `  Skills:\n${skills}`,
      ].join("\n");
    }),
  ].join("\n");
}

export class McpAgentBridge {
  private server: McpServer;
  private registry: RegistryClient;
  private options: Required<McpAdapterOptions>;
  private clientAgentId: string | null = null;
  private clientHeartbeatTimer: NodeJS.Timeout | null = null;
  private embeddedAgent: AgentServer | null = null;
  private embeddedRegistry: RegistryServer | null = null;
  private registryWs: WebSocket | null = null;
  private registryWsReconnectTimer: NodeJS.Timeout | null = null;
  private registryWsReconnectAttempts = 0;
  private readonly MAX_WS_RECONNECT_ATTEMPTS = 5;
  private pendingResponses = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private agentToolMap = new Map<string, RegisteredTool[]>();
  private pendingPermissions = new Set<string>();

  constructor(options: McpAdapterOptions = {}) {
    this.options = {
      registryUrl: "http://localhost:4999",
      auto: true,
      projectPath: process.cwd(),
      registerSkillTools: false,
      useClaudeCode: false,
      ...options,
    };
    this.registry = new RegistryClient(this.options.registryUrl);
    this.server = new McpServer(
      { name: "agent-bridge", version: "0.1.0" },
      {
        capabilities: { experimental: { "claude/channel": {}, "claude/channel/permission": {} } },
        instructions:
          "You are connected to agent-bridge, a multi-agent communication hub. " +
          "Connected agents appear as <channel source=\"agent-bridge\" from_agent=\"<name>\" agent_id=\"<id>\"> events when they send you a message. " +
          "Use list_agents to discover available agents, agent_health to check if they are alive, " +
          "and ask_agent to send tasks or reply to incoming messages. " +
          "Always use ask_agent (with the originating agent_id) to respond to channel events.",
      },
    );
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

    // ── 1d. Register permission relay handler ─────────────────────────────
    this.setupPermissionRelay();

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
    const wsUrl = this.options.registryUrl.replace(/^http/, "ws") + "/ws";
    try {
      const ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        console.error(`[MCP] WebSocket connected to registry`);
        this.registryWs = ws;
        this.registryWsReconnectAttempts = 0;
        // Identify as the MCP adapter's client agent
        if (this.clientAgentId) {
          ws.send(JSON.stringify({ type: "identify", agentId: this.clientAgentId }));
        }
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // ── Dynamic agent discovery ──────────────────────────────────────
          if (msg.type === "snapshot" && Array.isArray(msg.agents)) {
            const snapshotAgents = msg.agents as RegistryEntry[];
            const snapshotIds = new Set(snapshotAgents.map(a => a.agentId));
            // Remove tools for agents no longer present (e.g. after registry restart)
            for (const trackedId of this.agentToolMap.keys()) {
              if (!snapshotIds.has(trackedId)) this.removeAgentTools(trackedId);
            }
            // Add tools for new agents only if skill tools are enabled
            if (this.options.registerSkillTools) {
              for (const agent of snapshotAgents) {
                if (agent.entryType !== "client" && agent.card?.skills?.length > 0) {
                  this.addAgentTools(agent); // idempotent via agentToolMap.has()
                }
              }
            }
          }

          if (msg.type === "agent.registered" && msg.data) {
            const entry = msg.data as RegistryEntry;
            if (this.options.registerSkillTools && entry.entryType !== "client" && entry.card?.skills?.length > 0) {
              this.addAgentTools(entry);
              console.error(`[MCP] New agent discovered: ${entry.name} (${entry.card.skills.length} skills)`);
            }
          }

          if (msg.type === "agent.deregistered" || msg.type === "agent.removed") {
            const agentId = (msg.data as { agentId: string })?.agentId;
            if (agentId) this.removeAgentTools(agentId);
          }

          if (msg.type === "agent.unhealthy") {
            const agentId = (msg.data as { agentId: string })?.agentId;
            if (agentId) this.setAgentToolsEnabled(agentId, false);
          }

          if (msg.type === "agent.heartbeat") {
            const agentId = (msg.data as { agentId: string })?.agentId;
            if (agentId) this.setAgentToolsEnabled(agentId, true);
          }

          // ── Push notifications from agents to Claude terminal ─────────────
          if (msg.type === "claude.notify" && msg.data) {
            const notify = msg.data as { agentId?: string; agentName?: string; content: string; meta?: Record<string, unknown> };
            void this.server.server.notification({
              method: "notifications/claude/channel",
              params: {
                content: notify.content,
                // source is set automatically by Claude Code from the MCP server name
                meta: {
                  ...(notify.agentId ? { from_agent: notify.agentId } : {}),
                  ...(notify.agentName ? { agent_name: notify.agentName } : {}),
                  ...stringifyMeta(notify.meta),
                },
              },
            });
          }

          // ── Pending response relay ────────────────────────────────────────
          if (msg.type === "agent.message" && msg.data) {
            const agentMsg = msg.data as AgentMessage;

            // Incoming request from another agent → check for permission verdict first
            if (agentMsg.type === "task.request") {
              const payload = agentMsg.payload as { message?: string; skillId?: string } | null;
              const rawMessage = payload?.message ?? "";

              // Intercept "yes <id>" / "no <id>" verdict replies — don't forward to Claude
              const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
              const verdictMatch = PERMISSION_REPLY_RE.exec(rawMessage);
              if (verdictMatch) {
                const behavior = verdictMatch[1].toLowerCase().startsWith("y") ? "allow" : "deny";
                void this.sendPermissionVerdict(verdictMatch[2].toLowerCase(), behavior);
              } else {
              const content = rawMessage || JSON.stringify(payload);
              void this.server.server.notification({
                method: "notifications/claude/channel",
                params: {
                  content,
                  meta: {
                    from_agent: agentMsg.fromAgentId ?? "",
                    task_id: agentMsg.taskId ?? "",
                    ...(payload?.skillId ? { skill_id: payload.skillId } : {}),
                  },
                },
              });
              } // end else (not a verdict)
            }

            // Response to a pending request → resolve the promise
            if (agentMsg.type === "task.response" && agentMsg.taskId) {
              const pending = this.pendingResponses.get(agentMsg.taskId);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingResponses.delete(agentMsg.taskId);
                pending.resolve(agentMsg.payload);
              }
            }
          }
        } catch {
          // Ignore
        }
      });

      ws.on("close", () => {
        this.registryWs = null;
        this.scheduleWsReconnect();
      });

      ws.on("error", () => {
        this.registryWs = null;
      });
    } catch {
      this.scheduleWsReconnect();
    }
  }

  private scheduleWsReconnect(): void {
    if (this.registryWsReconnectTimer) return;
    if (this.registryWsReconnectAttempts >= this.MAX_WS_RECONNECT_ATTEMPTS) {
      console.error(`[MCP] WS reconnect limit reached (${this.MAX_WS_RECONNECT_ATTEMPTS}). WS relay disabled — HTTP fallback active.`);
      return;
    }
    this.registryWsReconnectAttempts++;
    this.registryWsReconnectTimer = setTimeout(() => {
      this.registryWsReconnectTimer = null;
      this.connectRegistryWs();
    }, 5_000);
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

  // ── Permission relay ──────────────────────────────────────────────────────

  private setupPermissionRelay(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerServer = (this.server as unknown as { server: any }).server;
    if (!innerServer?.setNotificationHandler) return;

    // setNotificationHandler requires a Zod schema with z.literal() on the method field
    const PermissionRequestSchema = z.object({
      method: z.literal("notifications/claude/channel/permission_request"),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string().optional(),
      }),
    });

    // Claude Code sends this when a tool approval dialog opens
    innerServer.setNotificationHandler(
      PermissionRequestSchema,
      async (notification: { params: { request_id: string; tool_name: string; description: string; input_preview?: string } }) => {
        const { request_id, tool_name, description } = notification.params;
        this.pendingPermissions.add(request_id);

        // Forward to all connected agents via notify-claude
        const content =
          `Claude wants to run **${tool_name}**: ${description}\n\n` +
          `Reply "yes ${request_id}" or "no ${request_id}" to approve or deny.`;

        try {
          await fetch(`${this.options.registryUrl}/notify-claude`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content,
              meta: { type: "permission_request", request_id, tool_name },
            }),
          });
        } catch {
          // Registry unreachable — local terminal dialog still open
        }
      }
    );
  }

  /** Send a permission verdict to Claude Code */
  private async sendPermissionVerdict(requestId: string, behavior: "allow" | "deny"): Promise<void> {
    if (!this.pendingPermissions.has(requestId)) return;
    this.pendingPermissions.delete(requestId);
    try {
      await this.server.server.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id: requestId, behavior },
      });
    } catch { /* ignore */ }
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
        const clientVersion = innerServer.getClientVersion?.();
        if (!clientVersion?.name) return;

        const clientName: string = clientVersion.name;
        const version: string = clientVersion.version ?? "unknown";
        this.clientAgentId = `client-${clientName}-${Date.now()}`;

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

        // Identify on existing WS connection
        if (this.registryWs?.readyState === WebSocket.OPEN) {
          this.registryWs.send(JSON.stringify({ type: "identify", agentId: this.clientAgentId }));
        }

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

        await fetch(`${this.options.registryUrl}/agents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(registration),
        });
        console.error(`[MCP] Registered client: ${realProjectName} (${clientName} v${version})`);

        this.clientHeartbeatTimer = setInterval(async () => {
          if (!this.clientAgentId) return;
          try {
            await fetch(`${this.options.registryUrl}/agents/${this.clientAgentId}/heartbeat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ agentId: this.clientAgentId, timestamp: Date.now(), status: "alive" }),
            });
          } catch { /* ignore heartbeat errors */ }
        }, 30_000);

        const cleanup = async () => {
          if (this.clientHeartbeatTimer) { clearInterval(this.clientHeartbeatTimer); this.clientHeartbeatTimer = null; }
          if (this.clientAgentId) {
            try {
              await fetch(`${this.options.registryUrl}/agents/${this.clientAgentId}`, { method: "DELETE" });
            } catch { /* ignore */ }
            this.clientAgentId = null;
          }
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
        console.error("[MCP] Failed to register client:", err);
      }
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
          "Use list_agents to see available agents.",
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
      "reply",
      {
        description:
          "Reply to an incoming channel event from an agent. " +
          "Use this when you receive a <channel> event and want to respond to the originating agent. " +
          "This is a shorthand for ask_agent focused on two-way channel communication.",
        inputSchema: {
          agentId: z.string().describe("Agent ID from the channel event (agent_id attribute)"),
          message: z.string().describe("Your reply message"),
          skillId: z.string().optional().describe("Skill to invoke on the target agent"),
        },
      },
      async ({ agentId, message, skillId }) => {
        try {
          const entry = await this.resolveAgent(agentId);

          if (this.registryWs?.readyState === WebSocket.OPEN) {
            try {
              const result = await this.sendMessageViaWs(entry.agentId, message, { skillId, timeoutMs: 60_000 });
              const rpcResult = result as { result?: unknown; error?: { message: string } };
              if (rpcResult?.error) {
                return { content: [{ type: "text" as const, text: `Agent error: ${rpcResult.error.message}` }], isError: true };
              }
              const task = rpcResult?.result ?? result;
              return { content: [{ type: "text" as const, text: extractTaskResponse(task) }] };
            } catch {
              // fallthrough to HTTP
            }
          }

          if (!entry.url) {
            return {
              content: [{ type: "text" as const, text: `Agent "${entry.name}" has no HTTP endpoint. WS relay unavailable.` }],
              isError: true,
            };
          }

          const client = new A2AClient(entry.url);
          const task = await client.sendTask({
            message: { role: "user", parts: [{ type: "text", text: message }] },
            metadata: skillId ? { skillId } : {},
          });
          return { content: [{ type: "text" as const, text: extractTaskResponse(task) }] };
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
              "- **ask_agent** — Send any message/task to an agent",
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
