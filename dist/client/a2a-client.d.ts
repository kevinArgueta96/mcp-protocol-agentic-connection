import type { AgentCard, Task, TaskSendParams, TaskStatusUpdateEvent } from "../types/a2a.js";
export declare class A2AClient {
    private readonly baseUrl;
    constructor(baseUrl: string);
    getCard(): Promise<AgentCard>;
    sendTask(params: TaskSendParams): Promise<Task>;
    getTask(id: string): Promise<Task>;
    cancelTask(id: string): Promise<Task>;
    sendTaskSubscribe(params: TaskSendParams): AsyncGenerator<TaskStatusUpdateEvent>;
    private rpc;
    private streamRpc;
    health(): Promise<{
        ok: boolean;
        status?: string;
        agentId: string;
        projectName?: string;
        port?: number;
    }>;
}
//# sourceMappingURL=a2a-client.d.ts.map