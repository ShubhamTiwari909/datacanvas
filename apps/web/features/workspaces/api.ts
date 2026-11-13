/**
 * Calls for saved workspaces. Components use these, never `fetch`.
 */
import {
  listWorkspacesResponseSchema,
  okResponseSchema,
  workspaceResponseSchema,
  type Workspace,
  type WorkspaceInput,
  type WorkspaceSummary,
} from "@datacanvas/shared-types";
import { apiRequest, type ApiResult } from "@/lib/api-client";

export async function listWorkspaces(profileId: string): Promise<ApiResult<WorkspaceSummary[]>> {
  const result = await apiRequest(
    `/api/workspaces?profileId=${encodeURIComponent(profileId)}`,
    listWorkspacesResponseSchema,
  );
  return result.ok ? { ok: true, data: result.data.workspaces } : result;
}

export async function getWorkspace(id: string): Promise<ApiResult<Workspace>> {
  const result = await apiRequest(
    `/api/workspaces/${encodeURIComponent(id)}`,
    workspaceResponseSchema,
  );
  return result.ok ? { ok: true, data: result.data.workspace } : result;
}

/** Create or update. The id is chosen by the caller; the server stamps the timestamps. */
export async function saveWorkspace(
  id: string,
  input: WorkspaceInput,
): Promise<ApiResult<Workspace>> {
  const result = await apiRequest(
    `/api/workspaces/${encodeURIComponent(id)}`,
    workspaceResponseSchema,
    {
      method: "PUT",
      body: input,
    },
  );
  return result.ok ? { ok: true, data: result.data.workspace } : result;
}

export function deleteWorkspace(id: string): Promise<ApiResult<{ ok: true }>> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(id)}`, okResponseSchema, {
    method: "DELETE",
  });
}

/** Import the parsed content of an exported file as a new workspace attached to `profileId`. */
export async function importWorkspace(
  content: unknown,
  profileId: string,
): Promise<ApiResult<Workspace>> {
  const result = await apiRequest(
    `/api/workspaces/import?profileId=${encodeURIComponent(profileId)}`,
    workspaceResponseSchema,
    { method: "POST", body: content },
  );
  return result.ok ? { ok: true, data: result.data.workspace } : result;
}

/** URL that downloads a workspace as a file (used by a normal link, so the browser saves it). */
export function exportUrl(id: string): string {
  return `/api/workspaces/${encodeURIComponent(id)}/export`;
}
