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
  /** Channel namespace this session belongs to. Sessions only see messages and
   *  peers sharing the same identity. Defaults to "global" when omitted. */
  identity?: string;
  clientInfo?: {
    clientName: string;
    clientVersion: string;
  };
  /** OS process id of the registering client/agent. Stamped automatically at
   *  registration. Lets `oab prune` verify the owning process is still alive
   *  (same host) and reap zombie entries left by leaked/orphaned sessions. */
  pid?: number;
  /** Hostname of the machine the registering process runs on. `oab prune` only
   *  acts on processes it can verify locally, i.e. entries whose host matches. */
  host?: string;
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
  /** Restrict results to peers in this channel namespace. */
  identity?: string;
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
  /** Channel namespace. Only sessions with a matching identity see this message.
   *  Defaults to "global" when omitted. */
  identity?: string;
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
