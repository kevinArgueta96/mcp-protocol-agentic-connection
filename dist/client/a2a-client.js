// A2A HTTP client — talks to any A2A-compliant agent server
import { randomUUID } from "node:crypto";
import { isJsonRpcError } from "../types/jsonrpc.js";
export class A2AClient {
    baseUrl;
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }
    async getCard() {
        const res = await fetch(`${this.baseUrl}/.well-known/agent.json`);
        if (!res.ok)
            throw new Error(`Failed to fetch agent card: ${res.status}`);
        return res.json();
    }
    async sendTask(params) {
        const result = await this.rpc("tasks/send", { ...params, id: params.id ?? randomUUID() });
        return result;
    }
    async getTask(id) {
        const result = await this.rpc("tasks/get", { id });
        return result;
    }
    async cancelTask(id) {
        const result = await this.rpc("tasks/cancel", { id });
        return result;
    }
    async *sendTaskSubscribe(params) {
        // TODO: implement SSE streaming via fetch ReadableStream
        yield* this.streamRpc("tasks/sendSubscribe", {
            ...params,
            id: params.id ?? randomUUID(),
        });
    }
    async rpc(method, params) {
        const request = {
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
        const response = (await res.json());
        if (isJsonRpcError(response)) {
            throw new Error(`RPC Error ${response.error.code}: ${response.error.message}`);
        }
        return response.result;
    }
    async *streamRpc(method, params) {
        // TODO: implement full SSE streaming
        const request = {
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
        if (!res.body)
            throw new Error("No response body for streaming");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const data = JSON.parse(line.slice(6));
                    if (!isJsonRpcError(data)) {
                        yield data.result;
                    }
                }
            }
        }
    }
    async health() {
        const res = await fetch(`${this.baseUrl}/health`);
        const data = await res.json();
        return { status: data.ok ? "alive" : "error", ...data };
    }
}
//# sourceMappingURL=a2a-client.js.map