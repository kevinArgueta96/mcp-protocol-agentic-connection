/**
 * MCP Adapter — Bridges local A2A agents as MCP tools for Claude Code, Codex, Gemini CLI
 *
 * When connected, Claude Code sees:
 *  - One MCP tool per skill per agent (e.g. "billing_api__endpoint_find")
 *  - Meta-tools: list_agents, agent_health, project_files, project_info
 *  - Resources: each agent's Agent Card at agents://{agentId}/card
 *  - A prompt showing what agents are connected and what they can do
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RegistryClient } from "../client/registry-client.js";
import { A2AClient } from "../client/a2a-client.js";
/** Sanitize agent name for use as a tool name prefix */
function toolPrefix(name) {
    return name.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_").toLowerCase();
}
/** Format agent list as readable text for Claude */
function formatAgentsSummary(agents) {
    if (agents.length === 0) {
        return "No agents currently connected. Start one with: agent-bridge start <project-path>";
    }
    const lines = [
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
    ];
    return lines.join("\n");
}
export class McpAgentBridge {
    server;
    registry;
    options;
    constructor(options = {}) {
        this.options = { registerSkillTools: true, ...options };
        this.registry = new RegistryClient(options.registryUrl);
        this.server = new McpServer({ name: "agent-bridge", version: "0.1.0" });
    }
    /** Discover agents, register all tools and resources, then connect transport */
    async start(transport = "stdio", httpPort = 6000) {
        // ── 1. Discover active agents ──────────────────────────────────────────
        let agents = [];
        try {
            agents = await this.registry.listAgents({ healthy: true });
        }
        catch {
            console.error("[MCP] Registry not available — starting with meta-tools only");
        }
        // ── 2. Register meta-tools (always available) ──────────────────────────
        this.registerMetaTools();
        // ── 3. Register per-agent skill tools ─────────────────────────────────
        if (this.options.registerSkillTools && agents.length > 0) {
            this.registerAgentSkillTools(agents);
        }
        // ── 4. Register Agent Card resources ──────────────────────────────────
        this.registerResources(agents);
        // ── 5. Register connected-agents prompt ───────────────────────────────
        this.registerPrompts(agents);
        // ── 6. Connect transport ───────────────────────────────────────────────
        if (transport === "stdio") {
            const stdioTransport = new StdioServerTransport();
            await this.server.connect(stdioTransport);
            // Stdio: log to stderr only
            console.error(`[MCP] agent-bridge connected via stdio. ${agents.length} agent(s) discovered.`);
            if (agents.length > 0) {
                console.error("[MCP] Available agents:\n" + agents.map((a) => `  • ${a.name} (${a.projectPath})`).join("\n"));
            }
        }
        else {
            await this.startHttpTransport(httpPort, agents);
        }
    }
    // ── Meta-tools ─────────────────────────────────────────────────────────────
    registerMetaTools() {
        // list_agents — discover all connected agents
        this.server.registerTool("list_agents", {
            description: "List all agents currently connected to agent-bridge. " +
                "Shows each agent's project path, type, health status, and available skills. " +
                "Use this first to know which agents you can interact with.",
            inputSchema: {
                skill: z.string().optional().describe("Filter agents that have this skill (e.g. 'endpoint-find')"),
                project: z.string().optional().describe("Filter by project name or path substring"),
                healthyOnly: z.boolean().optional().describe("Only show healthy agents (default: true)"),
            },
        }, async ({ skill, project, healthyOnly = true }) => {
            try {
                const agents = await this.registry.listAgents({
                    skill,
                    project,
                    healthy: healthyOnly ? true : undefined,
                });
                return { content: [{ type: "text", text: formatAgentsSummary(agents) }] };
            }
            catch {
                return {
                    content: [{ type: "text", text: "Registry not reachable at localhost:4999. Start it with: agent-bridge registry start" }],
                    isError: true,
                };
            }
        });
        // agent_health — ping an agent
        this.server.registerTool("agent_health", {
            description: "Check if a specific agent is alive and responding. Returns health status, project info, and available skills.",
            inputSchema: {
                agentId: z.string().describe("Agent ID (from list_agents) or agent name"),
            },
        }, async ({ agentId }) => {
            try {
                const entry = await this.resolveAgent(agentId);
                const client = new A2AClient(entry.url);
                const health = await client.health();
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                agent: entry.name,
                                agentId: entry.agentId,
                                status: health.status ?? "alive",
                                projectPath: entry.projectPath,
                                projectType: entry.projectType,
                                skills: entry.card.skills.map((s) => s.id),
                                url: entry.url,
                                wsUrl: entry.wsUrl,
                            }, null, 2),
                        }],
                };
            }
            catch (err) {
                return {
                    content: [{ type: "text", text: `Agent unreachable: ${err instanceof Error ? err.message : String(err)}` }],
                    isError: true,
                };
            }
        });
        // ask_agent — general purpose message to any agent
        this.server.registerTool("ask_agent", {
            description: "Send a message or task to any connected agent. " +
                "Specify skillId to invoke a specific skill (file-search, endpoint-find, code-query, prompt-execute). " +
                "Without skillId, the agent will try to infer the right skill from your message.",
            inputSchema: {
                agentId: z.string().describe("Target agent ID or name (from list_agents)"),
                message: z.string().describe("The message, question, or task to send"),
                skillId: z.string().optional().describe("Skill to invoke: file-search | endpoint-find | code-query | prompt-execute"),
                input: z.record(z.unknown()).optional().describe("Direct skill input as JSON object (overrides message parsing)"),
            },
        }, async ({ agentId, message, skillId, input }) => {
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
                // Extract result from artifact
                const artifact = task.artifacts[0];
                if (artifact?.parts[0]?.type === "data") {
                    return {
                        content: [{ type: "text", text: JSON.stringify(artifact.parts[0].data, null, 2) }],
                    };
                }
                return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
            }
            catch (err) {
                return {
                    content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                    isError: true,
                };
            }
        });
        // project_info — get project metadata from an agent
        this.server.registerTool("project_info", {
            description: "Get detailed project info from an agent: project name, path, type, and all available skills with descriptions.",
            inputSchema: {
                agentId: z.string().describe("Agent ID or name"),
            },
        }, async ({ agentId }) => {
            try {
                const entry = await this.resolveAgent(agentId);
                const client = new A2AClient(entry.url);
                // Use custom JSON-RPC method
                const result = await client.sendTask({
                    message: { role: "user", parts: [{ type: "text", text: "project info" }] },
                    metadata: { method: "project.info" },
                });
                const data = result.artifacts[0]?.parts[0];
                const payload = data?.type === "data" ? data.data : {
                    name: entry.name,
                    path: entry.projectPath,
                    type: entry.projectType,
                    skills: entry.card.skills,
                };
                return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
            }
            catch (err) {
                return {
                    content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                    isError: true,
                };
            }
        });
        // project_files — list files in a remote agent's project
        this.server.registerTool("project_files", {
            description: "List files and directory structure of a remote agent's project. " +
                "Useful to understand what exists in another project before asking for specific files or endpoints.",
            inputSchema: {
                agentId: z.string().describe("Agent ID or name"),
                depth: z.number().optional().describe("Directory depth to traverse (default: 2)"),
            },
        }, async ({ agentId, depth = 2 }) => {
            try {
                const entry = await this.resolveAgent(agentId);
                const client = new A2AClient(entry.url);
                const result = await client.sendTask({
                    message: { role: "user", parts: [{ type: "text", text: "list files" }] },
                    metadata: { skillId: "file-search", input: { pattern: "**/*", limit: 200 } },
                });
                const artifact = result.artifacts[0];
                const data = artifact?.parts[0]?.type === "data" ? artifact.parts[0].data : null;
                const files = data?.files ?? [];
                return {
                    content: [{
                            type: "text",
                            text: `Project: ${entry.name}\nPath: ${entry.projectPath}\n\nFiles (${files.length}):\n${files.map((f) => `  ${f}`).join("\n")}`,
                        }],
                };
            }
            catch (err) {
                return {
                    content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                    isError: true,
                };
            }
        });
    }
    // ── Per-agent skill tools ──────────────────────────────────────────────────
    registerAgentSkillTools(agents) {
        for (const agent of agents) {
            const prefix = toolPrefix(agent.name);
            for (const skill of agent.card.skills) {
                const toolName = `${prefix}__${skill.id.replace(/-/g, "_")}`;
                const skillSchemas = this.getSkillInputSchema(skill.id);
                this.server.registerTool(toolName, {
                    description: `[${agent.name}] ${skill.description}\n` +
                        `Project: ${agent.projectPath} (${agent.projectType})\n` +
                        `Tags: ${skill.tags.join(", ")}`,
                    inputSchema: skillSchemas,
                }, async (input) => {
                    try {
                        const client = new A2AClient(agent.url);
                        const task = await client.sendTask({
                            message: { role: "user", parts: [{ type: "text", text: JSON.stringify(input) }] },
                            metadata: { skillId: skill.id, input },
                        });
                        const artifact = task.artifacts[0];
                        const data = artifact?.parts[0];
                        if (data?.type === "data") {
                            return { content: [{ type: "text", text: JSON.stringify(data.data, null, 2) }] };
                        }
                        return { content: [{ type: "text", text: JSON.stringify(task.status, null, 2) }] };
                    }
                    catch (err) {
                        return {
                            content: [{ type: "text", text: `Error on ${agent.name}: ${err instanceof Error ? err.message : String(err)}` }],
                            isError: true,
                        };
                    }
                });
            }
        }
    }
    /** Map skill IDs to their known Zod input schemas */
    getSkillInputSchema(skillId) {
        switch (skillId) {
            case "file-search":
                return {
                    pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/**/*.json')"),
                    limit: z.number().optional().describe("Max results (default: 100)"),
                };
            case "endpoint-find":
                return {
                    query: z.string().optional().describe("Filter endpoints by keyword (e.g. 'payment', 'auth')"),
                    framework: z
                        .enum(["auto", "express", "nestjs", "fastapi", "spring", "hono"])
                        .optional()
                        .describe("Framework hint (default: auto)"),
                };
            case "code-query":
                return {
                    query: z.string().describe("Text or regex to search in code"),
                    fileGlob: z.string().optional().describe("Limit to files matching this glob"),
                    maxResults: z.number().optional().describe("Max matches (default: 50)"),
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
                    input: z.record(z.unknown()).optional().describe("Structured input as JSON"),
                };
        }
    }
    // ── Resources — Agent Cards ────────────────────────────────────────────────
    registerResources(agents) {
        // Static resource: list of all connected agents
        this.server.registerResource("connected-agents", "agents://connected", {
            description: "Current list of all agents connected to agent-bridge with their capabilities",
            mimeType: "application/json",
        }, async () => ({
            contents: [{
                    uri: "agents://connected",
                    mimeType: "application/json",
                    text: JSON.stringify(agents.map((a) => ({
                        agentId: a.agentId,
                        name: a.name,
                        projectPath: a.projectPath,
                        projectType: a.projectType,
                        port: a.port,
                        healthy: a.healthy,
                        skills: a.card.skills.map((s) => ({ id: s.id, description: s.description, tags: s.tags })),
                    })), null, 2),
                }],
        }));
        // Dynamic resource per agent: agent card
        if (agents.length > 0) {
            const template = new ResourceTemplate("agents://{agentId}/card", { list: undefined });
            this.server.registerResource("agent-card", template, {
                description: "A2A Agent Card for a specific connected agent",
                mimeType: "application/json",
            }, async (uri, { agentId }) => {
                const agent = agents.find((a) => a.agentId === agentId || a.name === agentId);
                if (!agent) {
                    throw new Error(`Agent "${agentId}" not found`);
                }
                return {
                    contents: [{
                            uri: uri.href,
                            mimeType: "application/json",
                            text: JSON.stringify(agent.card, null, 2),
                        }],
                };
            });
        }
    }
    // ── Prompts ────────────────────────────────────────────────────────────────
    registerPrompts(agents) {
        this.server.registerPrompt("agent_bridge_status", {
            description: "Shows which agents are connected and what each can do. Run this first to understand the available capabilities.",
            argsSchema: {},
        }, async () => ({
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
                            "- **ask_agent** — Send any message/task to an agent (with optional skillId)",
                            "- **project_info** — Get project metadata from an agent",
                            "- **project_files** — List files in a remote project",
                            agents.length > 0
                                ? `\n## Per-Agent Tools (registered at startup)\n${agents.flatMap((a) => a.card.skills.map((s) => `- **${toolPrefix(a.name)}__${s.id.replace(/-/g, "_")}** — ${s.description}`)).join("\n")}`
                                : "",
                        ].filter(Boolean).join("\n"),
                    },
                }],
        }));
    }
    // ── Helpers ────────────────────────────────────────────────────────────────
    /** Resolve agentId by exact ID, name match, or short ID prefix */
    async resolveAgent(agentId) {
        // Try exact ID first
        try {
            return await this.registry.getAgent(agentId);
        }
        catch {
            // Try by name/prefix
            const all = await this.registry.listAgents();
            const match = all.find((a) => a.name.toLowerCase() === agentId.toLowerCase() ||
                a.agentId.startsWith(agentId) ||
                a.projectPath.toLowerCase().includes(agentId.toLowerCase()));
            if (!match)
                throw new Error(`Agent "${agentId}" not found. Use list_agents to see available agents.`);
            return match;
        }
    }
    // ── HTTP Transport ─────────────────────────────────────────────────────────
    async startHttpTransport(port, agents) {
        const { default: express } = await import("express");
        const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
        const app = express();
        app.use(express.json());
        // SSE transport endpoint for MCP over HTTP
        let transport = null;
        app.get("/mcp", async (_req, res) => {
            transport = new SSEServerTransport("/mcp/message", res);
            await this.server.connect(transport);
            console.error(`[MCP] Client connected via SSE at http://localhost:${port}/mcp`);
        });
        app.post("/mcp/message", async (req, res) => {
            if (!transport) {
                res.status(400).json({ error: "No active SSE connection" });
                return;
            }
            await transport.handlePostMessage(req, res);
        });
        // Status page
        app.get("/", (_req, res) => {
            res.json({
                server: "agent-bridge MCP",
                agents: agents.length,
                endpoints: { sse: `/mcp`, message: `/mcp/message` },
                tools: [
                    "list_agents", "agent_health", "ask_agent",
                    "project_info", "project_files",
                    ...agents.flatMap((a) => a.card.skills.map((s) => `${toolPrefix(a.name)}__${s.id.replace(/-/g, "_")}`)),
                ],
            });
        });
        await new Promise((resolve) => app.listen(port, "localhost", () => resolve()));
        console.error(`[MCP] HTTP server running at http://localhost:${port}`);
        console.error(`[MCP] SSE endpoint: http://localhost:${port}/mcp`);
        console.error(`[MCP] ${agents.length} agent(s) discovered, ${agents.reduce((n, a) => n + a.card.skills.length, 0)} tools registered`);
    }
}
//# sourceMappingURL=adapter.js.map