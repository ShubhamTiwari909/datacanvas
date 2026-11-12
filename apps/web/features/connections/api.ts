/**
 * Connection management calls. Components use these functions, never `fetch`.
 */
import {
  connectionResponseSchema,
  listConnectionsResponseSchema,
  okResponseSchema,
  type ConnectionSummary,
} from "@datacanvas/shared-types";
import { apiRequest, type ApiResult } from "@/lib/api-client";

/** Check that connection details work, without saving anything. `input` is validated by the server. */
export function testConnection(input: unknown): Promise<ApiResult<{ ok: true }>> {
  return apiRequest("/api/connections/test", okResponseSchema, { method: "POST", body: input });
}

/** Connect and remember the connection (on the server, in memory). */
export async function createConnection(input: unknown): Promise<ApiResult<ConnectionSummary>> {
  const result = await apiRequest("/api/connections", connectionResponseSchema, {
    method: "POST",
    body: input,
  });
  return result.ok ? { ok: true, data: result.data.connection } : result;
}

export async function listConnections(): Promise<ApiResult<ConnectionSummary[]>> {
  const result = await apiRequest("/api/connections", listConnectionsResponseSchema);
  return result.ok ? { ok: true, data: result.data.connections } : result;
}

/** Disconnect and make the server forget the credentials. */
export function deleteConnection(id: string): Promise<ApiResult<{ ok: true }>> {
  return apiRequest(`/api/connections/${encodeURIComponent(id)}`, okResponseSchema, {
    method: "DELETE",
  });
}
