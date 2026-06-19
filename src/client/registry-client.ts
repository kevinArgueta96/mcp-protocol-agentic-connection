// Client for querying the local registry
import type { RegistryEntry, AgentListFilter } from "../types/messages.js";

const DEFAULT_REGISTRY_URL = "http://localhost:4999";

export class RegistryClient {
  constructor(private readonly registryUrl = DEFAULT_REGISTRY_URL) {}

  async listAgents(filter?: AgentListFilter): Promise<RegistryEntry[]> {
    const params = new URLSearchParams();
    if (filter?.skill) params.set("skill", filter.skill);
    if (filter?.project) params.set("project", filter.project);
    if (filter?.healthy !== undefined) params.set("healthy", String(filter.healthy));

    const url = `${this.registryUrl}/agents${params.size > 0 ? `?${params}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Registry error: ${res.status}`);
    return res.json() as Promise<RegistryEntry[]>;
  }

  async getAgent(agentId: string): Promise<RegistryEntry> {
    const res = await fetch(`${this.registryUrl}/agents/${agentId}`);
    if (!res.ok) throw new Error(`Agent not found: ${agentId}`);
    return res.json() as Promise<RegistryEntry>;
  }

  async deregister(agentId: string): Promise<boolean> {
    const res = await fetch(`${this.registryUrl}/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`Registry error: ${res.status}`);
    const body = await res.json() as { removed: boolean };
    return body.removed;
  }

  async findAgentByProject(projectPath: string): Promise<RegistryEntry | undefined> {
    const agents = await this.listAgents({ project: projectPath });
    return agents.find((a) => a.projectPath === projectPath) ?? agents[0];
  }

  async findClientSession(params: { clientId?: string; project?: string }): Promise<RegistryEntry | undefined> {
    const agents = await this.listAgents();
    const clients = agents.filter((entry) => entry.entryType === "client");

    if (params.clientId) {
      const clientId = params.clientId;
      return clients.find((entry) => entry.agentId === clientId || entry.agentId.startsWith(clientId));
    }

    if (params.project) {
      const project = params.project.toLowerCase();
      return clients.find((entry) =>
        entry.projectPath.toLowerCase().includes(project) ||
        entry.projectName.toLowerCase().includes(project)
      );
    }

    return undefined;
  }

  async findClaudeClient(params: { clientId?: string; project?: string }): Promise<RegistryEntry | undefined> {
    return this.findClientSession(params);
  }

  async health(): Promise<{ status: string; agents: number }> {
    const res = await fetch(`${this.registryUrl}/health`);
    return res.json() as Promise<{ status: string; agents: number }>;
  }

  async suppressChannelConversation(conversationId: string): Promise<boolean> {
    const res = await fetch(`${this.registryUrl}/channel/conversations/${encodeURIComponent(conversationId)}/suppress`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Failed to suppress conversation: ${res.status}`);
    const body = await res.json() as { suppressed: boolean };
    return body.suppressed;
  }

  async reviveChannelConversation(conversationId: string): Promise<boolean> {
    const res = await fetch(`${this.registryUrl}/channel/conversations/${encodeURIComponent(conversationId)}/suppress`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`Failed to revive conversation: ${res.status}`);
    const body = await res.json() as { revived: boolean };
    return body.revived;
  }

  async listChannelConversations(options?: { pendingOnly?: boolean }): Promise<import("../types/messages.js").ChannelConversationListEntry[]> {
    const params = new URLSearchParams();
    if (options?.pendingOnly) params.set("pending", "true");
    const url = `${this.registryUrl}/channel/conversations${params.size > 0 ? `?${params}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Registry error: ${res.status}`);
    return res.json() as Promise<import("../types/messages.js").ChannelConversationListEntry[]>;
  }

  async getChannelConversation(conversationId: string): Promise<import("../types/messages.js").ChannelConversationSnapshot | undefined> {
    const res = await fetch(`${this.registryUrl}/channel/conversations/${encodeURIComponent(conversationId)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Registry error: ${res.status}`);
    return res.json() as Promise<import("../types/messages.js").ChannelConversationSnapshot>;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.health();
      return true;
    } catch {
      return false;
    }
  }
}
