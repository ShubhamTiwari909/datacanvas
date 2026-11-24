/**
 * JSON-RPC 2.0, the part of it the Model Context Protocol uses (`docs/mcp-server-plan.md`, section 5). Pure functions: no
 * network, no framework. A body is untrusted text from another program: it is parsed strictly and every answer is built
 * here, so a malformed request can only ever produce a JSON-RPC error that repeats nothing of what was sent.
 */

export const JSONRPC_VERSION = "2.0";

/** The codes of JSON-RPC 2.0. */
export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: RequestId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  /** null when the id could not be read (the request was not valid enough to have one). */
  id: RequestId | null;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** The most messages one batch may hold. */
export const MAX_BATCH = 20;

export const success = (id: RequestId, result: unknown): JsonRpcSuccess => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  result,
});

/** An error answer. The message is a fixed sentence: it never repeats what the client sent. */
export const failure = (id: RequestId | null, code: number, message: string): JsonRpcFailure => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  error: { code, message },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type Classified =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "response" }
  | { kind: "invalid"; id: RequestId | null };

/** What one element of a body is: a request (it has an id), a notification, a response of the client, or nothing valid. */
export function classify(value: unknown): Classified {
  if (!isObject(value) || value["jsonrpc"] !== JSONRPC_VERSION)
    return { kind: "invalid", id: null };
  const id = value["id"];
  const idOk = typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
  const method = value["method"];
  if (typeof method === "string" && method.length > 0 && method.length <= 200) {
    const params = value["params"];
    if (params !== undefined && !isObject(params) && !Array.isArray(params)) {
      return { kind: "invalid", id: idOk ? id : null };
    }
    if ("id" in value) {
      return idOk
        ? { kind: "request", message: { jsonrpc: "2.0", id, method, params } }
        : { kind: "invalid", id: null };
    }
    return { kind: "notification", message: { jsonrpc: "2.0", method, params } };
  }
  // A result or an error from the client (an answer to something the server asked: this server asks nothing).
  if (idOk && ("result" in value || "error" in value)) return { kind: "response" };
  return { kind: "invalid", id: idOk ? id : null };
}
