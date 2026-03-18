const DEFAULT_REGISTRY_URL = "http://localhost:4999";
export class RegistryClient {
    registryUrl;
    constructor(registryUrl = DEFAULT_REGISTRY_URL) {
        this.registryUrl = registryUrl;
    }
    async listAgents(filter) {
        const params = new URLSearchParams();
        if (filter?.skill)
            params.set("skill", filter.skill);
        if (filter?.project)
            params.set("project", filter.project);
        if (filter?.healthy !== undefined)
            params.set("healthy", String(filter.healthy));
        const url = `${this.registryUrl}/agents${params.size > 0 ? `?${params}` : ""}`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`Registry error: ${res.status}`);
        return res.json();
    }
    async getAgent(agentId) {
        const res = await fetch(`${this.registryUrl}/agents/${agentId}`);
        if (!res.ok)
            throw new Error(`Agent not found: ${agentId}`);
        return res.json();
    }
    async findAgentByProject(projectPath) {
        const agents = await this.listAgents({ project: projectPath });
        return agents.find((a) => a.projectPath === projectPath) ?? agents[0];
    }
    async health() {
        const res = await fetch(`${this.registryUrl}/health`);
        return res.json();
    }
    async isAvailable() {
        try {
            await this.health();
            return true;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=registry-client.js.map