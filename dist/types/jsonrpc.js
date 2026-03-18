// JSON-RPC 2.0 envelope types
export function isJsonRpcError(res) {
    return "error" in res;
}
// Standard JSON-RPC error codes
export const RpcErrorCodes = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    // Custom A2A error codes
    TASK_NOT_FOUND: -32000,
    TASK_NOT_CANCELABLE: -32001,
    PUSH_NOTIFICATION_NOT_SUPPORTED: -32002,
    UNSUPPORTED_OPERATION: -32003,
};
//# sourceMappingURL=jsonrpc.js.map