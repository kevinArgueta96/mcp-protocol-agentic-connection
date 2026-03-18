import type { Task, TaskSendParams, TaskStatus, Artifact } from "../types/a2a.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../types/jsonrpc.js";
import type { SkillRegistry } from "../skills/framework.js";
export declare class TaskStore {
    private tasks;
    create(params: TaskSendParams): Task;
    get(id: string): Task | undefined;
    update(id: string, status: TaskStatus, artifacts?: Artifact[]): Task;
    complete(id: string, result: unknown): Task;
    fail(id: string, message: string): Task;
    cancel(id: string): Task;
    list(): Task[];
}
export interface RouterContext {
    agentId: string;
    projectPath: string;
    projectName: string;
    projectType: string;
    taskStore: TaskStore;
    skillRegistry: SkillRegistry;
}
type Handler = (params: unknown, ctx: RouterContext) => Promise<unknown>;
export declare class RequestRouter {
    private handlers;
    constructor();
    private registerDefaults;
    register(method: string, handler: Handler): void;
    dispatch(request: JsonRpcRequest, ctx: RouterContext): Promise<JsonRpcResponse>;
}
export {};
//# sourceMappingURL=handlers.d.ts.map