// TaskStore and RequestRouter — JSON-RPC 2.0 dispatch + skill execution
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Task, TaskSendParams, TaskStatus, Artifact, TextPart } from "../types/a2a.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../types/jsonrpc.js";
import { RpcErrorCodes } from "../types/jsonrpc.js";
import type { SkillRegistry } from "../skills/framework.js";
import type { SkillContext } from "../types/skills.js";

// ─── Task Store ───────────────────────────────────────────────────────────────

export interface TaskUpdateEvent {
  agentId: string;
  taskId: string;
  state: string;
  skillId?: string;
  timestamp: string;
  payload?: unknown;
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  private conversationToTask = new Map<string, string>();
  private taskToConversation = new Map<string, string>();
  private pendingReplyTimers = new Map<string, NodeJS.Timeout>();
  private agentId: string;
  private onTaskUpdate?: (event: TaskUpdateEvent) => void;

  constructor(agentId?: string, onTaskUpdate?: (event: TaskUpdateEvent) => void) {
    this.agentId = agentId ?? "";
    this.onTaskUpdate = onTaskUpdate;
  }

  private fireUpdate(taskId: string, state: string, skillId?: string, payload?: unknown): void {
    if (this.onTaskUpdate) {
      this.onTaskUpdate({
        agentId: this.agentId,
        taskId,
        state,
        skillId,
        timestamp: new Date().toISOString(),
        payload,
      });
    }
  }

  create(params: TaskSendParams): Task {
    const id = params.id ?? randomUUID();
    const task: Task = {
      id,
      contextId: params.contextId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      history: [params.message],
      artifacts: [],
      metadata: params.metadata,
    };
    this.tasks.set(id, task);
    this.fireUpdate(id, "submitted", params.metadata?.skillId as string | undefined);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getPendingTaskForConversation(conversationId: string): Task | undefined {
    const taskId = this.conversationToTask.get(conversationId);
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  update(id: string, status: TaskStatus, artifacts?: Artifact[]): Task {
    const task = this.tasks.get(id);
    if (!task) throw { code: RpcErrorCodes.TASK_NOT_FOUND, message: `Task ${id} not found` };
    const updated: Task = { ...task, status, artifacts: artifacts ?? task.artifacts };
    this.tasks.set(id, updated);
    this.fireUpdate(id, status.state);
    return updated;
  }

  complete(id: string, result: unknown): Task {
    const artifact: Artifact = {
      index: 0,
      lastChunk: true,
      parts: [{ type: "data", data: result as Record<string, unknown> }],
    };
    const task = this.tasks.get(id);
    if (!task) throw { code: RpcErrorCodes.TASK_NOT_FOUND, message: `Task ${id} not found` };
    const updated: Task = {
      ...task,
      status: { state: "completed", timestamp: new Date().toISOString() },
      artifacts: [artifact],
    };
    this.tasks.set(id, updated);
    this.fireUpdate(id, "completed", undefined, result);
    return updated;
  }

  awaitInput(
    id: string,
    params: {
      conversationId: string;
      messageId: string;
      content: string;
      skillId?: string;
      timeoutMs?: number;
    }
  ): Task {
    const task = this.tasks.get(id);
    if (!task) throw { code: RpcErrorCodes.TASK_NOT_FOUND, message: `Task ${id} not found` };

    this.conversationToTask.set(params.conversationId, id);
    this.taskToConversation.set(id, params.conversationId);

    const updated: Task = {
      ...task,
      status: {
        state: "input-required",
        timestamp: new Date().toISOString(),
        message: {
          role: "agent",
          parts: [{ type: "text", text: `Waiting for reply in conversation ${params.conversationId}` }],
        },
      },
      metadata: {
        ...task.metadata,
        conversationId: params.conversationId,
        channelMessageId: params.messageId,
        awaitingReply: true,
        skillId: params.skillId ?? task.metadata?.skillId,
      },
      history: [
        ...task.history,
        { role: "agent", parts: [{ type: "text", text: params.content }] },
      ],
    };

    this.tasks.set(id, updated);
    const timeoutMs = Math.max(1_000, params.timeoutMs ?? 300_000);
    const existingTimer = this.pendingReplyTimers.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      const current = this.tasks.get(id);
      if (!current || current.status.state !== "input-required") return;
      this.fail(id, `Timed out waiting for reply in conversation ${params.conversationId}`);
      this.conversationToTask.delete(params.conversationId);
      this.taskToConversation.delete(id);
      this.pendingReplyTimers.delete(id);
    }, timeoutMs);
    this.pendingReplyTimers.set(id, timer);
    this.fireUpdate(id, "input-required", params.skillId, {
      conversationId: params.conversationId,
      messageId: params.messageId,
      timeoutMs,
    });
    return updated;
  }

  resolveConversationReply(params: {
    conversationId?: string;
    taskId?: string;
    messageId: string;
    replyTo?: string;
    fromAgentId: string;
    content: string;
  }): Task | undefined {
    const taskId = params.taskId ??
      (params.conversationId ? this.conversationToTask.get(params.conversationId) : undefined);
    if (!taskId) return undefined;

    const task = this.tasks.get(taskId);
    if (!task || task.status.state !== "input-required") return undefined;

    const conversationId = params.conversationId ??
      this.taskToConversation.get(taskId) ??
      (typeof task.metadata?.conversationId === "string" ? task.metadata.conversationId : undefined);
    if (!conversationId) return undefined;

    const artifact: Artifact = {
      index: 0,
      lastChunk: true,
      parts: [{
        type: "data",
        data: {
          conversationId,
          messageId: params.messageId,
          replyTo: params.replyTo,
          fromAgentId: params.fromAgentId,
          content: params.content,
        },
      }],
    };

    const updated: Task = {
      ...task,
      status: { state: "completed", timestamp: new Date().toISOString() },
      artifacts: [artifact],
      metadata: {
        ...task.metadata,
        awaitingReply: false,
        lastReplyMessageId: params.messageId,
      },
      history: [
        ...task.history,
        { role: "user", parts: [{ type: "text", text: params.content }] },
      ],
    };

    this.tasks.set(taskId, updated);
    const timer = this.pendingReplyTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.pendingReplyTimers.delete(taskId);
    }
    this.conversationToTask.delete(conversationId);
    this.taskToConversation.delete(taskId);
    this.fireUpdate(taskId, "completed", task.metadata?.skillId as string | undefined, artifact.parts[0]);
    return updated;
  }

  fail(id: string, message: string): Task {
    const errorPart: TextPart = { type: "text", text: message };
    const task = this.tasks.get(id);
    if (!task) throw { code: RpcErrorCodes.TASK_NOT_FOUND, message: `Task ${id} not found` };
    const updated: Task = {
      ...task,
      status: {
        state: "failed",
        timestamp: new Date().toISOString(),
        message: { role: "agent", parts: [errorPart] },
      },
      artifacts: task.artifacts,
    };
    this.tasks.set(id, updated);
    const timer = this.pendingReplyTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pendingReplyTimers.delete(id);
    }
    const conversationId = this.taskToConversation.get(id);
    if (conversationId) {
      this.taskToConversation.delete(id);
      this.conversationToTask.delete(conversationId);
    }
    this.fireUpdate(id, "failed", undefined, { error: message });
    return updated;
  }

  cancel(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw { code: RpcErrorCodes.TASK_NOT_FOUND, message: `Task ${id} not found` };
    const updated: Task = {
      ...task,
      status: { state: "canceled", timestamp: new Date().toISOString() },
      artifacts: task.artifacts,
    };
    this.tasks.set(id, updated);
    const timer = this.pendingReplyTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pendingReplyTimers.delete(id);
    }
    const conversationId = this.taskToConversation.get(id);
    if (conversationId) {
      this.taskToConversation.delete(id);
      this.conversationToTask.delete(conversationId);
    }
    this.fireUpdate(id, "canceled");
    return updated;
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }
}

// ─── Router Context ───────────────────────────────────────────────────────────

export interface RouterContext {
  agentId: string;
  projectPath: string;
  projectName: string;
  projectType: string;
  projectInfo?: {
    type: string;
    category?: string;
    framework?: string;
  };
  taskStore: TaskStore;
  skillRegistry: SkillRegistry;
  registryUrl?: string;
}

type Handler = (params: unknown, ctx: RouterContext) => Promise<unknown>;

// ─── Request Router ───────────────────────────────────────────────────────────

export class RequestRouter {
  private handlers = new Map<string, Handler>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {

    // ── A2A: tasks/send ──────────────────────────────────────────────────────
    this.register("tasks/send", async (params, ctx) => {
      const p = params as TaskSendParams;
      const task = ctx.taskStore.create(p);

      // Mark as working
      ctx.taskStore.update(task.id, { state: "working", timestamp: new Date().toISOString() });

      try {
        // Determine which skill to run
        const skillId = (p.metadata?.skillId as string | undefined) ?? inferSkillFromMessage(p);
        const skillContext = makeSkillContext(ctx.agentId, task.id, ctx.projectPath, ctx.projectInfo);

        if (skillId) {
          const skill = ctx.skillRegistry.get(skillId);
          if (!skill) {
            return ctx.taskStore.fail(task.id, `Skill "${skillId}" not found. Available: ${ctx.skillRegistry.list().map((s) => s.id).join(", ")}`);
          }
          // Parse and validate input from message text or metadata
          const rawInput = (p.metadata?.input as Record<string, unknown>) ?? parseInputFromMessage(p, skillId);
          const parsed = skill.inputSchema.safeParse(rawInput);
          if (!parsed.success) {
            return ctx.taskStore.fail(task.id, `Invalid input for skill "${skillId}": ${parsed.error.message}`);
          }
          const result = await skill.execute(parsed.data, skillContext);
          if (
            skillId === "notify-claude" &&
            isNotifyClaudePendingInput(parsed.data) &&
            isNotifyClaudePendingResult(result)
          ) {
            if (!result.delivered) {
              return ctx.taskStore.fail(task.id, "notify-claude did not reach the registry");
            }
            return ctx.taskStore.awaitInput(task.id, {
              conversationId: result.conversationId,
              messageId: result.messageId,
              content: parsed.data.content,
              skillId,
              timeoutMs: parsed.data.responseTimeoutMs,
            });
          }
          return ctx.taskStore.complete(task.id, result);
        }

        // No skill specified — echo project info as default response
        const defaultResult = {
          agentId: ctx.agentId,
          projectName: ctx.projectName,
          projectPath: ctx.projectPath,
          projectType: ctx.projectType,
          message: "Agent received your message. Specify a skillId in metadata to invoke a skill.",
          availableSkills: ctx.skillRegistry.list().map((s) => ({ id: s.id, description: s.description })),
        };
        return ctx.taskStore.complete(task.id, defaultResult);

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return ctx.taskStore.fail(task.id, msg);
      }
    });

    // ── A2A: tasks/get ───────────────────────────────────────────────────────
    this.register("tasks/get", async (params, ctx) => {
      const { id } = params as { id: string };
      const task = ctx.taskStore.get(id);
      if (!task) throw { code: RpcErrorCodes.TASK_NOT_FOUND, message: "Task not found" };
      return task;
    });

    // ── A2A: tasks/cancel ────────────────────────────────────────────────────
    this.register("tasks/cancel", async (params, ctx) => {
      const { id } = params as { id: string };
      return ctx.taskStore.cancel(id);
    });

    // ── Custom: agent.health ─────────────────────────────────────────────────
    this.register("agent.health", async (_params, ctx) => ({
      ok: true,
      agentId: ctx.agentId,
      projectName: ctx.projectName,
      projectPath: ctx.projectPath,
      projectType: ctx.projectType,
      status: "alive",
      timestamp: new Date().toISOString(),
      skills: ctx.skillRegistry.list().map((s) => s.id),
    }));

    // ── Custom: agent.hello ──────────────────────────────────────────────────
    this.register("agent.hello", async (_params, ctx) => ({
      ok: true,
      agentId: ctx.agentId,
      projectName: ctx.projectName,
      projectPath: ctx.projectPath,
      timestamp: new Date().toISOString(),
    }));

    // ── Custom: project.info ─────────────────────────────────────────────────
    this.register("project.info", async (_params, ctx) => ({
      agentId: ctx.agentId,
      projectName: ctx.projectName,
      projectPath: ctx.projectPath,
      projectType: ctx.projectType,
      projectCategory: ctx.projectInfo?.category,
      projectFramework: ctx.projectInfo?.framework,
      skills: ctx.skillRegistry.list().map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: s.tags,
      })),
    }));

    // ── Custom: project.files ────────────────────────────────────────────────
    this.register("project.files", async (params, ctx) => {
      const { depth = 2 } = params as { depth?: number };
      const files = await listDirectory(ctx.projectPath, depth);
      return {
        projectPath: ctx.projectPath,
        files,
        count: files.length,
      };
    });

    // ── Custom: project.search ───────────────────────────────────────────────
    this.register("project.search", async (params, ctx) => {
      const { query, fileGlob } = params as { query: string; fileGlob?: string };
      const skill = ctx.skillRegistry.get("code-query");
      if (!skill) return { matches: [], query };

      const skillContext = makeSkillContext(ctx.agentId, randomUUID(), ctx.projectPath, ctx.projectInfo);
      const result = await skill.execute({ query, fileGlob }, skillContext);
      return result;
    });
  }

  register(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  async dispatch(request: JsonRpcRequest, ctx: RouterContext): Promise<JsonRpcResponse> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: RpcErrorCodes.METHOD_NOT_FOUND,
          message: `Method not found: ${request.method}`,
        },
      };
    }
    try {
      const result = await handler(request.params, ctx);
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: e.code ?? RpcErrorCodes.INTERNAL_ERROR,
          message: e.message ?? "Internal error",
        },
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function makeSkillContext(
  agentId: string,
  taskId: string,
  projectPath: string,
  projectInfo?: { type: string; category?: string; framework?: string }
): SkillContext {
  return {
    agentId,
    taskId,
    projectPath,
    log: (level, message) => console.error(`[${level.toUpperCase()}] [${agentId.slice(0, 8)}] ${message}`),
    projectInfo,
  };
}

/** Try to infer skillId from message text keywords — natural language aware */
export function inferSkillFromMessage(params: TaskSendParams): string | undefined {
  const text = params.message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join(" ")
    .toLowerCase();

  // Score each skill based on keyword matches
  const scores: Record<string, number> = {
    "endpoint-find": 0,
    "file-search": 0,
    "code-query": 0,
    "prompt-execute": 0,
  };

  // endpoint-find: strong keywords only (all are domain-specific)
  const endpointKeywords = [
    { pattern: /\bendpoints?\b/, weight: 3 },
    { pattern: /\broutes?\b/, weight: 2 },
    { pattern: /\bapi\b/, weight: 2 },
    { pattern: /\bcontrollers?\b/, weight: 3 },
    { pattern: /\brestful\b|\brest\s+api\b|\brest\s+endpoint\b/, weight: 3 },
    { pattern: /\bgraphql\b/, weight: 3 },
    { pattern: /\bwebhook\b/, weight: 3 },
    { pattern: /\bhttp method\b|\bhttp endpoint\b/, weight: 3 },
    { pattern: /\bhandlers?\b/, weight: 1 },
  ];

  // file-search: specific file-finding intent
  const fileKeywords = [
    { pattern: /\blist files?\b/, weight: 3 },
    { pattern: /\bshow files?\b/, weight: 3 },
    { pattern: /\bwhat files?\b/, weight: 3 },
    { pattern: /\bfind files?\b|\bfind.*\.ts\b|\bfind.*\.\w{2,4}\b/, weight: 3 },
    { pattern: /\bdirectory\b|\bfolder\b/, weight: 3 },
    { pattern: /\bstructure\b/, weight: 2 },
    { pattern: /\bglob\b/, weight: 3 },
    { pattern: /\btree\b/, weight: 1 },
  ];

  // code-query: requires EITHER a strong keyword OR 2+ weak keywords
  const codeQueryStrongKeywords = [
    { pattern: /\bgrep\b/, weight: 4 },
    { pattern: /\bsearch.*code\b|\bcode.*search\b/, weight: 4 },
    { pattern: /\bfind.*in.*code\b|\bwhere.*defined\b/, weight: 4 },
    { pattern: /\bwhere is\b/, weight: 3 },
    { pattern: /\busage of\b|\breferences to\b/, weight: 3 },
    { pattern: /\bimports? of\b|\bimported by\b/, weight: 3 },
  ];
  const codeQueryWeakKeywords = [
    { pattern: /\bfind\b/, weight: 1 },
    { pattern: /\bfunction\b/, weight: 1 },
    { pattern: /\bclass\b/, weight: 1 },
    { pattern: /\bvariable\b/, weight: 1 },
    { pattern: /\binterface\b/, weight: 1 },
  ];

  // prompt-execute
  const promptKeywords = [
    { pattern: /\bprompt\b/, weight: 3 },
    { pattern: /\btemplate\b/, weight: 2 },
    { pattern: /\bplaceholder\b/, weight: 3 },
    { pattern: /\bfill.*template\b/, weight: 3 },
  ];

  // Apply scoring
  for (const kw of endpointKeywords) {
    if (kw.pattern.test(text)) scores["endpoint-find"] += kw.weight;
  }
  for (const kw of fileKeywords) {
    if (kw.pattern.test(text)) scores["file-search"] += kw.weight;
  }
  for (const kw of codeQueryStrongKeywords) {
    if (kw.pattern.test(text)) scores["code-query"] += kw.weight;
  }
  for (const kw of codeQueryWeakKeywords) {
    if (kw.pattern.test(text)) scores["code-query"] += kw.weight;
  }
  for (const kw of promptKeywords) {
    if (kw.pattern.test(text)) scores["prompt-execute"] += kw.weight;
  }

  // Only route if a skill has a meaningful score
  const MIN_SCORE = 3;
  const best = Object.entries(scores)
    .filter(([, score]) => score >= MIN_SCORE)
    .sort(([, a], [, b]) => b - a)[0];

  return best?.[0];
}

// Map skill IDs to their primary input field name
const SKILL_INPUT_FIELDS: Record<string, string> = {
  "file-search": "pattern",
  "code-query": "query",
  "endpoint-find": "query",
  "prompt-execute": "template",
  "claude-execute": "prompt",
};

/** Parse skill input from message text — tries JSON first, then plain string mapped to the skill's primary field */
export function parseInputFromMessage(
  params: TaskSendParams,
  skillId?: string
): Record<string, unknown> {
  const textParts = params.message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text);

  if (textParts.length === 0) return {};

  const text = textParts.join(" ").trim();

  // Try JSON
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed === "object") return parsed;
  } catch {
    // Not JSON — treat as plain string mapped to the skill's primary field
  }

  const fieldName = skillId ? (SKILL_INPUT_FIELDS[skillId] ?? "message") : "message";
  return { [fieldName]: text };
}

function isNotifyClaudePendingInput(input: unknown): input is {
  content: string;
  expectsResponse?: boolean;
  responseTimeoutMs?: number;
} {
  if (!input || typeof input !== "object") return false;
  const maybe = input as { content?: unknown; expectsResponse?: unknown; responseTimeoutMs?: unknown };
  return typeof maybe.content === "string" &&
    maybe.expectsResponse === true &&
    (maybe.responseTimeoutMs === undefined || typeof maybe.responseTimeoutMs === "number");
}

function isNotifyClaudePendingResult(result: unknown): result is {
  delivered: boolean;
  conversationId: string;
  messageId: string;
} {
  if (!result || typeof result !== "object") return false;
  const maybe = result as { delivered?: unknown; conversationId?: unknown; messageId?: unknown };
  return typeof maybe.delivered === "boolean" &&
    typeof maybe.conversationId === "string" &&
    typeof maybe.messageId === "string";
}

/** List directory contents up to a given depth */
async function listDirectory(rootDir: string, maxDepth: number, current = 0): Promise<string[]> {
  if (current >= maxDepth) return [];

  const IGNORE = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".venv"]);
  const results: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return [];
  }

  for (const entry of entries.slice(0, 50)) { // Limit per-level
    if (IGNORE.has(entry)) continue;

    const fullPath = join(rootDir, entry);
    let isDir = false;
    try {
      const s = await stat(fullPath);
      isDir = s.isDirectory();
    } catch {
      continue;
    }

    const rel = fullPath.replace(rootDir + "/", "");
    results.push(isDir ? `${rel}/` : rel);

    if (isDir) {
      const sub = await listDirectory(fullPath, maxDepth, current + 1);
      results.push(...sub.map((s) => `${entry}/${s}`));
    }
  }

  return results;
}
