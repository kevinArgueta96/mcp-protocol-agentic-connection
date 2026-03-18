// A2A HTTP client — talks to any A2A-compliant agent server
import { randomUUID } from "node:crypto";
import type { AgentCard, Task, TaskSendParams, TaskStatusUpdateEvent } from "../types/a2a.js";
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcSuccessResponse } from "../types/jsonrpc.js";
import { isJsonRpcError } from "../types/jsonrpc.js";

export class A2AClient {
  constructor(private readonly baseUrl: string) {}

  async getCard(): Promise<AgentCard> {
    const res = await fetch(`${this.baseUrl}/.well-known/agent.json`);
    if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.status}`);
    return res.json() as Promise<AgentCard>;
  }

  async sendTask(params: TaskSendParams): Promise<Task> {
    const result = await this.rpc("tasks/send", { ...params, id: params.id ?? randomUUID() });
    return result as Task;
  }

  async getTask(id: string): Promise<Task> {
    const result = await this.rpc("tasks/get", { id });
    return result as Task;
  }

  async cancelTask(id: string): Promise<Task> {
    const result = await this.rpc("tasks/cancel", { id });
    return result as Task;
  }

  async *sendTaskSubscribe(params: TaskSendParams): AsyncGenerator<TaskStatusUpdateEvent> {
    // TODO: implement SSE streaming via fetch ReadableStream
    yield* this.streamRpc("tasks/sendSubscribe", {
      ...params,
      id: params.id ?? randomUUID(),
    });
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    const response = (await res.json()) as JsonRpcResponse;

    if (isJsonRpcError(response)) {
      throw new Error(`RPC Error ${response.error.code}: ${response.error.message}`);
    }

    return (response as JsonRpcSuccessResponse).result;
  }

  private async *streamRpc(method: string, params: unknown): AsyncGenerator<TaskStatusUpdateEvent> {
    // TODO: implement full SSE streaming
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(request),
    });

    if (!res.body) throw new Error("No response body for streaming");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6)) as JsonRpcResponse;
          if (!isJsonRpcError(data)) {
            yield (data as JsonRpcSuccessResponse).result as TaskStatusUpdateEvent;
          }
        }
      }
    }
  }

  async health(): Promise<{ ok: boolean; status?: string; agentId: string; projectName?: string; port?: number }> {
    const res = await fetch(`${this.baseUrl}/health`);
    const data = await res.json() as { ok: boolean; status?: string; agentId: string; projectName?: string; port?: number };
    return { status: data.ok ? "alive" : "error", ...data };
  }
}
