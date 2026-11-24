/** Calls for sharing a connection with Claude through MCP (decision 169). Components use these, never `fetch`. */
import { claudeSharingResponseSchema, type ClaudeLevel } from "@datacanvas/shared-types";
import { apiRequest, type ApiResult } from "@/lib/api-client";

const url = (connectionId: string): string =>
  `/api/connections/${encodeURIComponent(connectionId)}/claude`;

export async function getClaudeSharing(connectionId: string): Promise<ApiResult<ClaudeLevel>> {
  const result = await apiRequest(url(connectionId), claudeSharingResponseSchema);
  return result.ok ? { ok: true, data: result.data.sharing.level } : result;
}

export async function setClaudeSharing(
  connectionId: string,
  level: ClaudeLevel,
): Promise<ApiResult<ClaudeLevel>> {
  const result = await apiRequest(url(connectionId), claudeSharingResponseSchema, {
    method: "PUT",
    body: { level },
  });
  return result.ok ? { ok: true, data: result.data.sharing.level } : result;
}
