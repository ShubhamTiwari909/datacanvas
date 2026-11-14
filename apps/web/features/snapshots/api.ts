/**
 * Calls for structure snapshots and the live structure. Components use these,
 * never `fetch`.
 */
import {
  listSnapshotsResponseSchema,
  okResponseSchema,
  snapshotResponseSchema,
  snapshotSummaryResponseSchema,
  structureResponseSchema,
  type CreateSnapshotInput,
  type Snapshot,
  type SnapshotSummary,
} from "@datacanvas/shared-types";
import type { DatabaseStructure } from "@datacanvas/database-core";
import { apiRequest, type ApiResult } from "@/lib/api-client";

export async function listSnapshots(): Promise<ApiResult<SnapshotSummary[]>> {
  const result = await apiRequest("/api/snapshots", listSnapshotsResponseSchema);
  return result.ok ? { ok: true, data: result.data.snapshots } : result;
}

export async function getSnapshot(id: string): Promise<ApiResult<Snapshot>> {
  const result = await apiRequest(
    `/api/snapshots/${encodeURIComponent(id)}`,
    snapshotResponseSchema,
  );
  return result.ok ? { ok: true, data: result.data.snapshot } : result;
}

/** The server reads the structure itself; the browser only names the connection. */
export async function createSnapshot(
  connectionId: string,
  input: CreateSnapshotInput,
): Promise<ApiResult<SnapshotSummary>> {
  const result = await apiRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/snapshots`,
    snapshotSummaryResponseSchema,
    { method: "POST", body: input },
  );
  return result.ok ? { ok: true, data: result.data.snapshot } : result;
}

export function deleteSnapshot(id: string): Promise<ApiResult<{ ok: true }>> {
  return apiRequest(`/api/snapshots/${encodeURIComponent(id)}`, okResponseSchema, {
    method: "DELETE",
  });
}

/** Import the parsed content of an exported file as a new snapshot. */
export async function importSnapshot(content: unknown): Promise<ApiResult<SnapshotSummary>> {
  const result = await apiRequest("/api/snapshots/import", snapshotSummaryResponseSchema, {
    method: "POST",
    body: content,
  });
  return result.ok ? { ok: true, data: result.data.snapshot } : result;
}

/** URL that downloads a snapshot as a file (a normal link, so the browser saves it). */
export function snapshotExportUrl(id: string): string {
  return `/api/snapshots/${encodeURIComponent(id)}/export`;
}

/** The whole live structure of a connection's database. Nothing is saved. */
export async function getLiveStructure(
  connectionId: string,
): Promise<ApiResult<DatabaseStructure>> {
  const result = await apiRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/structure`,
    structureResponseSchema,
  );
  return result.ok ? { ok: true, data: result.data.structure } : result;
}
