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

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RegistryClient } from "../client/registry-client.js";
import { A2AClient } from "../client/a2a-client.js";
import { RegistryServer } from "../registry/server.js";
import { AgentServer } from "../agent/server.js";
import type { RegistryEntry } from "../types/messages.js";

export interface McpAdapterOptions {
  registryUrl?: string;
  /** Auto-start registry + local agent if none found (default: true) */
  auto?: boolean;
  /** Project path for the auto-started agent (default: cwd) */
  projectPath?: string;
  /** Register per-agent skill tools in addition to meta-tools (default: true) */
  registerSkillTools?: boolean;
}

function toolPrefix(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_").toLowerCase();
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
        `  Type:    ${a.projectType}`,
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

  constructor(options: McpAdapterOptions = {}) {
    this.options = {
      registryUrl: "http://localhost:4999",
      auto: true,
      projectPath: process.cwd(),
      registerSkillTools: true,
      ...options,
    };
    this.registry = new RegistryClient(this.options.registryUrl);
    this.server = new McpServer({ name: "agent-bridge", version: "0.1.0" });
  }

  async start(transport: "stdio" | "http" = "stdio", httpPort = 6000): Promise<void> {
    // ── 1. Ensure registry + at least one agent is running ─────────────────
    const agents = await this.ensureInfrastructure();

    // ── 2. Register all tools, resources, prompts ──────────────────────────
    this.registerMetaTools();
    if (this.options.registerSkillTools && agents.length > 0) {
      this.registerAgentSkillTools(agents);
    }
    this.registerResources(agents);
    this.registerPrompts(agents);

    // ── 3. Connect transport ───────────────────────────────────────────────
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
      const registryServer = new RegistryServer();
      await registryServer.start();
    }

    // Check if any agents are registered
    let agents = await this.registry.listAgents({ healthy: true });

    if (agents.length === 0 && this.options.auto) {
      // Auto-start a local agent for the current project
      console.error(`[MCP] No agents found — starting agent for: ${this.options.projectPath}`);
      const agentServer = new AgentServer({
        projectPath: this.options.projectPath,
        registryUrl: this.options.registryUrl,
      });
      await agentServer.start();

      // Give it a moment to register
      await new Promise((r) => setTimeout(r, 300));
      agents = await this.registry.listAgents({ healthy: true });
    }

    return agents;
  }

  // ── Meta-tools ─────────────────────────────────────────────────────────────

  private registerMetaTools(): void {

    this.server.registerTool(
      "list_agents",
      {
        description:
          "List all agents connected to agent-bridge. Shows each agent's project path, type, " +
          "health status, and available skills. Use this first to discover what you can work with.",
        inputSchema: {
          skill: z.string().optional().describe("Filter agents with this skill (e.g. 'endpoint-find')"),
          project: z.string().optional().describe("Filter by project name or path substring"),
          healthyOnly: z.boolean().optional().describe("Only show healthy agents (default: true)"),
        },
      },
      async ({ skill, project, healthyOnly = true }) => {
        try {
          const agents = await this.registry.listAgents({
            skill,
            project,
            healthy: healthyOnly ? true : undefined,
          });
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
          "Optionally specify a skillId to invoke a specific capability. " +
          "Skills: file-search, endpoint-find, code-query, prompt-execute.",
        inputSchema: {
          agentId: z.string().describe("Target agent ID or name (from list_agents)"),
          message: z.string().describe("The message, question, or task to send"),
          skillId: z.string().optional().describe("Skill to invoke: file-search | endpoint-find | code-query | prompt-execute"),
          input: z.record(z.unknown()).optional().describe("Direct skill input as JSON (overrides message parsing)"),
        },
      },
      async ({ agentId, message, skillId, input }) => {
        try {
          const entry = await this.resolveAgent(agentId);
          const client = new A2AClient(entry.url);
          const task = await client.sendTask({
            message: { role: "user", parts: [{ type: "text", text: message }] },
            metadata: {
              ...(skillId ? { skillId } : {}),
              ...(input ? { input } : {}),
            },
          });
          const artifact = task.artifacts[0];
          if (artifact?.parts[0]?.type === "data") {
            return { content: [{ type: "text" as const, text: JSON.stringify(artifact.parts[0].data, null, 2) }] };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );

    this.server.registerTool(
      "project_info",
      {
        description: "Get detailed project info from an agent: name, path, type, and all skills.",
        inputSchema: {
          agentId: z.string().describe("Agent ID or name"),
        },
      },
      async ({ agentId }) => {
        try {
          const entry = await this.resolveAgent(agentId);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                name: entry.name,
                path: entry.projectPath,
                type: entry.projectType,
                port: entry.port,
                skills: entry.card.skills.map((s) => ({ id: s.id, description: s.description, tags: s.tags })),
              }, null, 2),
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
      "project_files",
      {
        description: "List files in a remote agent's project using glob pattern. Useful to explore project structure.",
        inputSchema: {
          agentId: z.string().describe("Agent ID or name"),
          pattern: z.string().optional().describe("Glob pattern (default: **/* — all files)"),
          limit: z.coerce.number().optional().describe("Max results (default: 100)"),
        },
      },
      async ({ agentId, pattern = "**/*", limit = 100 }) => {
        try {
          const entry = await this.resolveAgent(agentId);
          const client = new A2AClient(entry.url);
          const task = await client.sendTask({
            message: { role: "user", parts: [{ type: "text", text: "list files" }] },
            metadata: { skillId: "file-search", input: { pattern, limit } },
          });
          const artifact = task.artifacts[0];
          const data = artifact?.parts[0]?.type === "data" ? artifact.parts[0].data : null;
          const files = (data as { files?: string[] })?.files ?? [];
          return {
            content: [{
              type: "text" as const,
              text: `Project: ${entry.name}\nPath: ${entry.projectPath}\n\nFiles (${files.length}):\n${files.map((f) => `  ${f}`).join("\n")}`,
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
      const prefix = toolPrefix(agent.name);
      for (const skill of agent.card.skills) {
        const toolName = `${prefix}__${skill.id.replace(/-/g, "_")}`;
        this.server.registerTool(
          toolName,
          {
            description:
              `[${agent.name}] ${skill.description}\n` +
              `Project: ${agent.projectPath} (${agent.projectType})`,
            inputSchema: this.getSkillInputSchema(skill.id),
          },
          async (input) => {
            try {
              const client = new A2AClient(agent.url);
              const task = await client.sendTask({
                message: { role: "user", parts: [{ type: "text", text: JSON.stringify(input) }] },
                metadata: { skillId: skill.id, input },
              });
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
      }
    }
  }

  private getSkillInputSchema(skillId: string): Record<string, z.ZodTypeAny> {
    switch (skillId) {
      case "file-search":
        return {
          pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/**/*.json')"),
          limit: z.coerce.number().optional().describe("Max results (default: 100)"),
        };
      case "endpoint-find":
        return {
          query: z.string().optional().describe("Filter by keyword (e.g. 'payment', 'auth', 'user')"),
          framework: z
            .enum(["auto", "express", "nestjs", "fastapi", "spring", "hono"])
            .optional()
            .describe("Framework hint (default: auto)"),
        };
      case "code-query":
        return {
          query: z.string().describe("Text or regex to search in code files"),
          fileGlob: z.string().optional().describe("Limit to files matching this glob"),
          maxResults: z.coerce.number().optional().describe("Max matches (default: 50)"),
        };
      case "prompt-execute":
        return {
          template: z.string().describe("Prompt template with {{variable}} placeholders"),
          variables: z.record(z.string()).optional().describe("Variables to inject"),
          instruction: z.string().optional().describe("What to do with this prompt"),
        };
      default:
        return {
          message: z.string().describe("Input message for the skill"),
        };
    }
  }

  // ── Resources ──────────────────────────────────────────────────────────────

  private registerResources(agents: RegistryEntry[]): void {
    this.server.registerResource(
      "connected-agents",
      "agents://connected",
      {
        description: "All agents connected to agent-bridge with their capabilities",
        mimeType: "application/json",
      },
      async () => ({
        contents: [{
          uri: "agents://connected",
          mimeType: "application/json",
          text: JSON.stringify(
            agents.map((a) => ({
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
      })
    );

    if (agents.length > 0) {
      const template = new ResourceTemplate("agents://{agentId}/card", { list: undefined });
      this.server.registerResource(
        "agent-card",
        template,
        { description: "A2A Agent Card for a connected agent", mimeType: "application/json" },
        async (uri, { agentId }) => {
          const agent = agents.find((a) => a.agentId === agentId || a.name === agentId);
          if (!agent) throw new Error(`Agent "${agentId}" not found`);
          return {
            contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(agent.card, null, 2) }],
          };
        }
      );
    }
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
              "- **project_info** — Get project metadata from an agent",
              "- **project_files** — List files in a remote project",
              agents.length > 0
                ? `\n## Per-Agent Tools\n${agents.flatMap((a) =>
                    a.card.skills.map((s) => `- **${toolPrefix(a.name)}__${s.id.replace(/-/g, "_")}** — ${s.description}`)
                  ).join("\n")}`
                : "",
            ].filter(Boolean).join("\n"),
          },
        }],
      })
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async resolveAgent(agentId: string): Promise<RegistryEntry> {
    try {
      return await this.registry.getAgent(agentId);
    } catch {
      const all = await this.registry.listAgents();
      const match = all.find(
        (a) =>
          a.name.toLowerCase() === agentId.toLowerCase() ||
          a.agentId.startsWith(agentId) ||
          a.projectPath.toLowerCase().includes(agentId.toLowerCase())
      );
      if (!match) throw new Error(`Agent "${agentId}" not found. Use list_agents to see available agents.`);
      return match;
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
