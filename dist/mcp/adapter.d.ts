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
export interface McpAdapterOptions {
    registryUrl?: string;
    /** Auto-start registry + local agent if none found (default: true) */
    auto?: boolean;
    /** Project path for the auto-started agent (default: cwd) */
    projectPath?: string;
    /** Register per-agent skill tools in addition to meta-tools (default: true) */
    registerSkillTools?: boolean;
}
export declare class McpAgentBridge {
    private server;
    private registry;
    private options;
    constructor(options?: McpAdapterOptions);
    start(transport?: "stdio" | "http", httpPort?: number): Promise<void>;
    private ensureInfrastructure;
    private registerMetaTools;
    private registerAgentSkillTools;
    private getSkillInputSchema;
    private registerResources;
    private registerPrompts;
    private resolveAgent;
    private startHttpTransport;
}
//# sourceMappingURL=adapter.d.ts.map