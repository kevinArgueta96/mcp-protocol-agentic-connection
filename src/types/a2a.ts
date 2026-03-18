// A2A (Agent-to-Agent) protocol types — based on Google's A2A specification

// ─── Agent Card ───────────────────────────────────────────────────────────────

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  documentationUrl?: string;
  provider?: AgentProvider;
  capabilities: AgentCapabilities;
  authentication?: AgentAuthentication;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
}

export interface AgentProvider {
  organization: string;
  url?: string;
}

export interface AgentCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  stateTransitionHistory: boolean;
}

export interface AgentAuthentication {
  schemes: string[];
  credentials?: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

// ─── Task ─────────────────────────────────────────────────────────────────────

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp: string;
}

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  history: Message[];
  artifacts: Artifact[];
  metadata?: Record<string, unknown>;
}

// ─── Messages & Parts ─────────────────────────────────────────────────────────

export type MessageRole = "user" | "agent";

export interface Message {
  role: MessageRole;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

export interface TextPart {
  type: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface FilePart {
  type: "file";
  file: FileContent;
  metadata?: Record<string, unknown>;
}

export interface FileContent {
  name?: string;
  mimeType?: string;
  bytes?: string;   // base64-encoded
  uri?: string;
}

export interface DataPart {
  type: "data";
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

export interface Artifact {
  name?: string;
  description?: string;
  parts: Part[];
  index: number;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

// ─── Task streaming events ────────────────────────────────────────────────────

export interface TaskStatusUpdateEvent {
  id: string;
  status: TaskStatus;
  final: boolean;
}

export interface TaskArtifactUpdateEvent {
  id: string;
  artifact: Artifact;
}

// ─── RPC Params ───────────────────────────────────────────────────────────────

export interface TaskSendParams {
  id?: string;
  contextId?: string;
  message: Message;
  acceptedOutputModes?: string[];
  historyLength?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskQueryParams {
  id: string;
  historyLength?: number;
}

export interface TaskIdParams {
  id: string;
  metadata?: Record<string, unknown>;
}

// ─── A2A Method names ─────────────────────────────────────────────────────────

export const A2AMethods = {
  TASKS_SEND: "tasks/send",
  TASKS_SEND_SUBSCRIBE: "tasks/sendSubscribe",
  TASKS_GET: "tasks/get",
  TASKS_CANCEL: "tasks/cancel",
  // Custom local methods
  AGENT_HELLO: "agent.hello",
  AGENT_HEALTH: "agent.health",
  PROJECT_INFO: "project.info",
  PROJECT_FILES: "project.files",
  PROJECT_SEARCH: "project.search",
} as const;

export type A2AMethod = (typeof A2AMethods)[keyof typeof A2AMethods];