export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: string | number;
    method: string;
    params?: unknown;
}
export interface JsonRpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
}
export interface JsonRpcSuccessResponse {
    jsonrpc: "2.0";
    id: string | number;
    result: unknown;
}
export interface JsonRpcErrorResponse {
    jsonrpc: "2.0";
    id: string | number | null;
    error: JsonRpcError;
}
export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export declare function isJsonRpcError(res: JsonRpcResponse): res is JsonRpcErrorResponse;
export declare const RpcErrorCodes: {
    readonly PARSE_ERROR: -32700;
    readonly INVALID_REQUEST: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly INTERNAL_ERROR: -32603;
    readonly TASK_NOT_FOUND: -32000;
    readonly TASK_NOT_CANCELABLE: -32001;
    readonly PUSH_NOTIFICATION_NOT_SUPPORTED: -32002;
    readonly UNSUPPORTED_OPERATION: -32003;
};
//# sourceMappingURL=jsonrpc.d.ts.map