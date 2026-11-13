/**
 * Connection management calls. Components use these functions, never `fetch`.
 */
import {
  connectionResponseSchema,
  listConnectionsResponseSchema,
  listProfilesResponseSchema,
  okResponseSchema,
  type ConnectionProfile,
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

/** The saved connection profiles (never any password). */
export async function listProfiles(): Promise<ApiResult<ConnectionProfile[]>> {
  const result = await apiRequest("/api/profiles", listProfilesResponseSchema);
  return result.ok ? { ok: true, data: result.data.profiles } : result;
}

/** Forget a saved connection and delete the workspaces saved for it. */
export function deleteProfile(id: string): Promise<ApiResult<{ ok: true }>> {
  return apiRequest(`/api/profiles/${encodeURIComponent(id)}`, okResponseSchema, {
    method: "DELETE",
  });
}

/** Save a live connection's non-secret details as a profile. Answers with its updated summary. */
export async function saveConnection(connectionId: string): Promise<ApiResult<ConnectionSummary>> {
  const result = await apiRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/save`,
    connectionResponseSchema,
    { method: "POST" },
  );
  return result.ok ? { ok: true, data: result.data.connection } : result;
}
