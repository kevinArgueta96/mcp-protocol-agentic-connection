// Shared types for the agent-bridge dashboard

export type AgentState = "healthy" | "unhealthy" | "unknown";
export type TaskState = "submitted" | "working" | "completed" | "failed" | "canceled";

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: AgentSkill[];
}

export interface RegistryAgent {
  agentId: string;
  name: string;
  url: string;
  wsUrl: string;
  port: number;
  projectPath: string;
  projectName: string;
  projectType: "node" | "rust" | "go" | "python" | "java" | "unknown";
  card: AgentCard;
  registeredAt: number;
  lastHeartbeat: number;
  healthy: boolean;
  entryType?: "agent" | "client";
  clientInfo?: {
    clientName: string;
    clientVersion: string;
  };
}

export type TraceEventKind = "task" | "ag-ui-step" | "ag-ui-tool";

export interface TraceEvent {
  id: string;
  timestamp: string;
  agentId: string;
  agentName: string;
  taskId: string;
  state: TaskState;
  skillId?: string;
  duration?: number;
  payload?: unknown;
  expanded?: boolean;
  kind?: TraceEventKind;
  stepName?: string;
  toolCallName?: string;
  toolCallArgs?: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "tool";
  content: string;
  timestamp: string;
  streaming?: boolean;
  toolCall?: {
    name: string;
    args?: unknown;
    argsRaw?: string;
    result?: unknown;
    streaming?: boolean;
  };
}

// WebSocket messages from registry
export type WsMessage =
  | { type: "snapshot"; agents: RegistryAgent[] }
  | { type: "agent.registered"; timestamp: string; data: RegistryAgent }
  | { type: "agent.deregistered"; timestamp: string; data: { agentId: string } }
  | { type: "agent.heartbeat"; timestamp: string; data: { agentId: string; timestamp: number } }
  | { type: "agent.unhealthy"; timestamp: string; data: { agentId: string } }
  | { type: "agent.removed"; timestamp: string; data: { agentId: string } }
  | { type: "task.update"; timestamp: string; data: TaskUpdatePayload };

export interface TaskUpdatePayload {
  agentId: string;
  agentName: string;
  taskId: string;
  state: TaskState;
  skillId?: string;
  timestamp: string;
  payload?: unknown;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
