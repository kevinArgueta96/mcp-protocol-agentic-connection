// Custom extension types for local agent registry and communication
import type { AgentCard } from "./a2a.js";

export interface AgentRegistration {
  agentId: string;
  name: string;
  url: string;
  wsUrl: string;
  port: number;
  projectPath: string;
  projectName: string;
  projectType: string;
  card: AgentCard;
  registeredAt: number;
  entryType?: "agent" | "client";
  clientInfo?: {
    clientName: string;
    clientVersion: string;
  };
}

export interface AgentHeartbeat {
  agentId: string;
  timestamp: number;
  status: "alive" | "shutting-down";
}

export interface RegistryEntry extends AgentRegistration {
  lastHeartbeat: number;
  healthy: boolean;
}

export interface AgentListFilter {
  skill?: string;
  project?: string;
  healthy?: boolean;
  entryType?: "agent" | "client";
}

export interface AgentMessage {
  fromAgentId: string;
  toAgentId: string;
  taskId?: string;
  type: "task.request" | "task.response" | "notification";
  payload: unknown;
  timestamp: number;
}

export type ChannelMessageKind =
  | "chat"
  | "task_request"
  | "task_result"
  | "ack"
  | "error"
  | "presence";

export type ChannelDeliveryState =
  | "queued"
  | "delivered_to_bridge"
  | "displayed_to_client"
  | "answered"
  | "failed";

export interface ChannelMessage {
  conversationId: string;
  messageId: string;
  replyTo?: string;
  fromAgentId: string;
  fromAgentName?: string;
  toAgentId?: string;
  taskId?: string;
  kind: ChannelMessageKind;
  content: string;
  meta?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
  attemptCount?: number;
  requiresAck?: boolean;
  expectsResponse?: boolean;
}

export interface ChannelAck {
  conversationId: string;
  messageId: string;
  state: ChannelDeliveryState;
  actorId: string;
  actorType: "registry" | "bridge" | "client" | "agent";
  timestamp: number;
  detail?: string;
}

export interface ChannelConversationSnapshot {
  conversationId: string;
  messages: ChannelMessage[];
  acknowledgements: ChannelAck[];
}

export interface ChannelConversationListEntry {
  conversationId: string;
  lastMessage: ChannelMessage;
  pendingReply: boolean;
  expired: boolean;
  lastAckState?: ChannelDeliveryState;
  pendingCount?: number;
  pendingMessageIds?: string[];
  status?: "pending" | "expired" | "answered" | "failed" | "active";
}
