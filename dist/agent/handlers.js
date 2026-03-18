// TaskStore and RequestRouter — JSON-RPC 2.0 dispatch + skill execution
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { RpcErrorCodes } from "../types/jsonrpc.js";
// ─── Task Store ───────────────────────────────────────────────────────────────
export class TaskStore {
    tasks = new Map();
    create(params) {
        const id = params.id ?? randomUUID();
        const task = {
            id,
            contextId: params.contextId,
            status: { state: "submitted", timestamp: new Date().toISOString() },
            history: [params.message],
            artifacts: [],
            metadata: params.metadata,
        };
        this.tasks.set(id, task);
        return task;
    }
    get(id) {
        return this.tasks.get(id);
    }
    update(id, status, artifacts) {
        const task = this.tasks.get(id);
        if (!task)
            throw { code: RpcErrorCodes.TASK_NOT_FOUND, message: `Task ${id} not found` };
        const updated = { ...task, status, artifacts: artifacts ?? task.artifacts };
        this.tasks.set(id, updated);
        return updated;
    }
    complete(id, result) {
        const artifact = {
            index: 0,
            lastChunk: true,
            parts: [{ type: "data", data: result }],
        };
        return this.update(id, { state: "completed", timestamp: new Date().toISOString() }, [artifact]);
    }
    fail(id, message) {
        const errorPart = { type: "text", text: message };
        return this.update(id, {
            state: "failed",
            timestamp: new Date().toISOString(),
            message: { role: "agent", parts: [errorPart] },
        });
    }
    cancel(id) {
        return this.update(id, { state: "canceled", timestamp: new Date().toISOString() });
    }
    list() {
        return Array.from(this.tasks.values());
    }
}
// ─── Request Router ───────────────────────────────────────────────────────────
export class RequestRouter {
    handlers = new Map();
    constructor() {
        this.registerDefaults();
    }
    registerDefaults() {
        // ── A2A: tasks/send ──────────────────────────────────────────────────────
        this.register("tasks/send", async (params, ctx) => {
            const p = params;
            const task = ctx.taskStore.create(p);
            // Mark as working
            ctx.taskStore.update(task.id, { state: "working", timestamp: new Date().toISOString() });
            try {
                // Determine which skill to run
                const skillId = p.metadata?.skillId ?? inferSkillFromMessage(p);
                const skillContext = makeSkillContext(ctx.agentId, task.id, ctx.projectPath);
                if (skillId) {
                    const skill = ctx.skillRegistry.get(skillId);
                    if (!skill) {
                        return ctx.taskStore.fail(task.id, `Skill "${skillId}" not found. Available: ${ctx.skillRegistry.list().map((s) => s.id).join(", ")}`);
                    }
                    // Parse and validate input from message text or metadata
                    const rawInput = p.metadata?.input ?? parseInputFromMessage(p);
                    const parsed = skill.inputSchema.safeParse(rawInput);
                    if (!parsed.success) {
                        return ctx.taskStore.fail(task.id, `Invalid input for skill "${skillId}": ${parsed.error.message}`);
                    }
                    const result = await skill.execute(parsed.data, skillContext);
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
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return ctx.taskStore.fail(task.id, msg);
            }
        });
        // ── A2A: tasks/get ───────────────────────────────────────────────────────
        this.register("tasks/get", async (params, ctx) => {
            const { id } = params;
            const task = ctx.taskStore.get(id);
            if (!task)
                throw { code: RpcErrorCodes.TASK_NOT_FOUND, message: "Task not found" };
            return task;
        });
        // ── A2A: tasks/cancel ────────────────────────────────────────────────────
        this.register("tasks/cancel", async (params, ctx) => {
            const { id } = params;
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
            skills: ctx.skillRegistry.list().map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                tags: s.tags,
            })),
        }));
        // ── Custom: project.files ────────────────────────────────────────────────
        this.register("project.files", async (params, ctx) => {
            const { depth = 2 } = params;
            const files = await listDirectory(ctx.projectPath, depth);
            return {
                projectPath: ctx.projectPath,
                files,
                count: files.length,
            };
        });
        // ── Custom: project.search ───────────────────────────────────────────────
        this.register("project.search", async (params, ctx) => {
            const { query, fileGlob } = params;
            const skill = ctx.skillRegistry.get("code-query");
            if (!skill)
                return { matches: [], query };
            const skillContext = makeSkillContext(ctx.agentId, randomUUID(), ctx.projectPath);
            const result = await skill.execute({ query, fileGlob }, skillContext);
            return result;
        });
    }
    register(method, handler) {
        this.handlers.set(method, handler);
    }
    async dispatch(request, ctx) {
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
        }
        catch (err) {
            const e = err;
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
function makeSkillContext(agentId, taskId, projectPath) {
    return {
        agentId,
        taskId,
        projectPath,
        log: (level, message) => console.error(`[${level.toUpperCase()}] [${agentId.slice(0, 8)}] ${message}`),
    };
}
/** Try to infer skillId from message text keywords */
function inferSkillFromMessage(params) {
    const text = params.message.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .toLowerCase();
    if (text.includes("endpoint") || text.includes("route") || text.includes("api"))
        return "endpoint-find";
    if (text.includes("search") || text.includes("find") || text.includes("grep"))
        return "code-query";
    if (text.includes("file") || text.includes("list"))
        return "file-search";
    if (text.includes("prompt") || text.includes("template"))
        return "prompt-execute";
    return undefined;
}
/** Parse skill input from message text — tries JSON first, then plain string as query */
function parseInputFromMessage(params) {
    const textParts = params.message.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text);
    if (textParts.length === 0)
        return {};
    const text = textParts.join(" ").trim();
    // Try JSON
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object")
            return parsed;
    }
    catch {
        // Not JSON — treat as query string
    }
    return { query: text, pattern: text };
}
/** List directory contents up to a given depth */
async function listDirectory(rootDir, maxDepth, current = 0) {
    if (current >= maxDepth)
        return [];
    const IGNORE = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".venv"]);
    const results = [];
    let entries;
    try {
        entries = await readdir(rootDir);
    }
    catch {
        return [];
    }
    for (const entry of entries.slice(0, 50)) { // Limit per-level
        if (IGNORE.has(entry))
            continue;
        const fullPath = join(rootDir, entry);
        let isDir = false;
        try {
            const s = await stat(fullPath);
            isDir = s.isDirectory();
        }
        catch {
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
//# sourceMappingURL=handlers.js.map