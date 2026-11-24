/** Calls for sharing a connection with Claude through MCP (decision 169). Components use these, never `fetch`. */
import {
  claudeActivitySchema,
  claudeSharingResponseSchema,
  type ClaudeActivity,
  type ClaudeLevel,
} from "@datacanvas/shared-types";
import { z } from "zod";
import { apiRequest, type ApiResult } from "@/lib/api-client";

export interface ClaudeSharing {
  level: ClaudeLevel;
  /** At the data level: every call waits for the person's Approve. */
  approval: boolean;
}

const url = (connectionId: string): string =>
  `/api/connections/${encodeURIComponent(connectionId)}/claude`;

export async function getClaudeSharing(connectionId: string): Promise<ApiResult<ClaudeSharing>> {
  const result = await apiRequest(url(connectionId), claudeSharingResponseSchema);
  return result.ok ? { ok: true, data: result.data.sharing } : result;
}

export async function setClaudeSharing(
  connectionId: string,
  request: { level: ClaudeLevel; approval?: boolean; acknowledgeRole?: boolean },
): Promise<ApiResult<ClaudeSharing>> {
  const result = await apiRequest(url(connectionId), claudeSharingResponseSchema, {
    method: "PUT",
    body: request,
  });
  return result.ok ? { ok: true, data: result.data.sharing } : result;
}

export function getClaudeActivity(): Promise<ApiResult<ClaudeActivity>> {
  return apiRequest("/api/claude/activity", claudeActivitySchema);
}

/** Answer a call that waits for the person's Approve. */
export function decideClaudeCall(
  id: string,
  decision: "approve" | "deny",
): Promise<ApiResult<{ ok: boolean }>> {
  return apiRequest(
    `/api/claude/pending/${encodeURIComponent(id)}`,
    z.object({ ok: z.boolean() }),
    {
      method: "POST",
      body: { decision },
    },
  );
}

export function setClaudePaused(paused: boolean): Promise<ApiResult<{ paused: boolean }>> {
  return apiRequest("/api/claude/pause", z.object({ paused: z.boolean() }), {
    method: "PUT",
    body: { paused },
  });
}
