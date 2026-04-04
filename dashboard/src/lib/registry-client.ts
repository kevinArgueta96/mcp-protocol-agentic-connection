// REST client for the registry API
const BASE = import.meta.env.VITE_REGISTRY_URL ?? "http://localhost:4999";

import type { ChannelConversationListEntry, ChannelConversationSnapshot, ChannelMessagePayload, RegistryAgent } from "@/types";

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

export async function registerClient(entry: RegistryAgent): Promise<RegistryAgent> {
  const res = await fetch(`${BASE}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  if (!res.ok) throw new Error(`Client registration failed: ${res.status}`);
  return res.json() as Promise<RegistryAgent>;
}

export async function sendClientHeartbeat(agentId: string): Promise<void> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, timestamp: Date.now(), status: "alive" }),
  });
  if (!res.ok) throw new Error(`Heartbeat failed: ${res.status}`);
}

export async function deregisterClient(agentId: string): Promise<void> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Client deregistration failed: ${res.status}`);
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

export async function createChannelMessage(input: {
  conversationId?: string;
  replyTo?: string;
  fromAgentId: string;
  fromAgentName?: string;
  toAgentId: string;
  taskId?: string;
  kind?: string;
  content: string;
  meta?: Record<string, unknown>;
  requiresAck?: boolean;
  expectsResponse?: boolean;
  expiresAt?: number;
}): Promise<ChannelMessagePayload> {
  const res = await fetch(`${BASE}/channel/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: input.conversationId,
      replyTo: input.replyTo,
      fromAgentId: input.fromAgentId,
      fromAgentName: input.fromAgentName,
      toAgentId: input.toAgentId,
      taskId: input.taskId,
      kind: input.kind ?? "chat",
      content: input.content,
      meta: input.meta,
      requiresAck: input.requiresAck ?? true,
      expectsResponse: input.expectsResponse ?? true,
      expiresAt: input.expiresAt,
    }),
  });
  if (!res.ok) throw new Error(`Channel message failed: ${res.status}`);
  return res.json() as Promise<ChannelMessagePayload>;
}
