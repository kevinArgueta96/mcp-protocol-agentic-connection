// JSON-RPC 2.0 envelope types

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

export function isJsonRpcError(res: JsonRpcResponse): res is JsonRpcErrorResponse {
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
} as const;