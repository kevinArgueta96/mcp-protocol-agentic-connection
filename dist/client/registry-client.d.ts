import type { RegistryEntry, AgentListFilter } from "../types/messages.js";
export declare class RegistryClient {
    private readonly registryUrl;
    constructor(registryUrl?: string);
    listAgents(filter?: AgentListFilter): Promise<RegistryEntry[]>;
    getAgent(agentId: string): Promise<RegistryEntry>;
    findAgentByProject(projectPath: string): Promise<RegistryEntry | undefined>;
    health(): Promise<{
        status: string;
        agents: number;
    }>;
    isAvailable(): Promise<boolean>;
}
//# sourceMappingURL=registry-client.d.ts.map