import type { AgentRegistration, AgentListFilter, RegistryEntry } from "../types/messages.js";
export declare class AgentStore {
    private agents;
    register(registration: AgentRegistration): RegistryEntry;
    deregister(agentId: string): boolean;
    heartbeat(agentId: string): boolean;
    get(agentId: string): RegistryEntry | undefined;
    list(filter?: AgentListFilter): RegistryEntry[];
    findBySkill(tag: string): RegistryEntry[];
    findByProject(projectPath: string): RegistryEntry | undefined;
    healthCheck(): void;
    count(): number;
}
//# sourceMappingURL=store.d.ts.map