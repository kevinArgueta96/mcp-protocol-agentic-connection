// REST client for the registry API
const BASE = import.meta.env.VITE_REGISTRY_URL ?? "http://localhost:4999";

import type { ChannelConversationListEntry, ChannelConversationSnapshot, RegistryAgent } from "@/types";

export async function fetchAgents(filter?: {
  skill?: string;
  project?: string;
  healthy?: boolean;
}): Promise<RegistryAgent[]> {
  const params = new URLSearchParams();
  if (filter?.skill) params.set("skill", filter.skill);
  if (filter?.project) params.set("project", filter.project);
  if (filter?.healthy !== undefined) params.set("healthy", String(filter.healthy));
  const qs = params.toString();
  const res = await fetch(`${BASE}/agents${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Registry error: ${res.status}`);
  return res.json() as Promise<RegistryAgent[]>;
}

export async function fetchAgent(agentId: string): Promise<RegistryAgent> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}`);
  if (!res.ok) throw new Error(`Agent not found: ${agentId}`);
  return res.json() as Promise<RegistryAgent>;
}

export async function fetchRegistryHealth(): Promise<{
  status: string;
  agents: number;
  timestamp: string;
}> {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`Registry unhealthy: ${res.status}`);
  return res.json() as Promise<{ status: string; agents: number; timestamp: string }>;
}

export async function fetchChannelConversations(filter?: { pending?: boolean }): Promise<ChannelConversationListEntry[]> {
  const params = new URLSearchParams();
  if (filter?.pending !== undefined) params.set("pending", String(filter.pending));
  const qs = params.toString();
  const res = await fetch(`${BASE}/channel/conversations${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Channel conversations error: ${res.status}`);
  return res.json() as Promise<ChannelConversationListEntry[]>;
}

export async function fetchChannelConversation(conversationId: string): Promise<ChannelConversationSnapshot> {
  const res = await fetch(`${BASE}/channel/conversations/${encodeURIComponent(conversationId)}`);
  if (!res.ok) throw new Error(`Conversation not found: ${conversationId}`);
  return res.json() as Promise<ChannelConversationSnapshot>;
}
