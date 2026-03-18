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
}
