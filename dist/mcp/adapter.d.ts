/**
 * MCP Adapter — Bridges local A2A agents as MCP tools for Claude Code, Codex, Gemini CLI
 *
 * When connected, Claude Code sees:
 *  - One MCP tool per skill per agent (e.g. "billing_api__endpoint_find")
 *  - Meta-tools: list_agents, agent_health, project_files, project_info
 *  - Resources: each agent's Agent Card at agents://{agentId}/card
 *  - A prompt showing what agents are connected and what they can do
 */
export interface McpAdapterOptions {
    registryUrl?: string;
    /** If true, also register per-agent per-skill tools (verbose but powerful) */
    registerSkillTools?: boolean;
}
export declare class McpAgentBridge {
    private server;
    private registry;
    private options;
    constructor(options?: McpAdapterOptions);
    /** Discover agents, register all tools and resources, then connect transport */
    start(transport?: "stdio" | "http", httpPort?: number): Promise<void>;
    private registerMetaTools;
    private registerAgentSkillTools;
    /** Map skill IDs to their known Zod input schemas */
    private getSkillInputSchema;
    private registerResources;
    private registerPrompts;
    /** Resolve agentId by exact ID, name match, or short ID prefix */
    private resolveAgent;
    private startHttpTransport;
}
//# sourceMappingURL=adapter.d.ts.map