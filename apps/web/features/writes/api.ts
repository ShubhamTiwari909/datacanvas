/**
 * Calls for editing rows and designing tables (1.4.0). Components use these,
 * never `fetch`.
 *
 * Every request is a JSON body or a plain GET without values in the URL. A
 * change travels once, to `preview`; `apply` sends only the preview's id, so
 * the server runs exactly what was previewed. Nothing returned here is stored
 * outside memory, and no answer carries a row value back.
 */
import type { Change, TableEditInfo } from "@datacanvas/database-core";
import {
  IMPORT_MAX_BODY_BYTES,
  applyChangeResponseSchema,
  editInfoResponseSchema,
  historyResponseSchema,
  migrationResponseSchema,
  previewChangeResponseSchema,
  roleResponseSchema,
  writesStatusResponseSchema,
  type ChangePreview,
  type HistoryEntry,
  type MigrationFile,
  type RoleResponse,
  type WritesStatus,
} from "@datacanvas/shared-types";
import { apiRequest, type ApiResult } from "@/lib/api-client";

const base = (connectionId: string): string =>
  `/api/connections/${encodeURIComponent(connectionId)}`;

function unwrap<T, R>(result: ApiResult<T>, pick: (data: T) => R): ApiResult<R> {
  return result.ok ? { ok: true, data: pick(result.data) } : result;
}

/** Whether writes are possible on this connection, and which of the switches is missing. */
export async function getWritesStatus(connectionId: string): Promise<ApiResult<WritesStatus>> {
  const result = await apiRequest(`${base(connectionId)}/writes`, writesStatusResponseSchema);
  return unwrap(result, (d) => d.writes);
}

/** Unlock writes for this connection, for this session. `database` is the name the person typed. */
export async function unlockWrites(
  connectionId: string,
  database: string,
): Promise<ApiResult<WritesStatus>> {
  const result = await apiRequest(
    `${base(connectionId)}/writes/unlock`,
    writesStatusResponseSchema,
    {
      method: "POST",
      body: { database },
    },
  );
  return unwrap(result, (d) => d.writes);
}

export async function lockWrites(connectionId: string): Promise<ApiResult<WritesStatus>> {
  const result = await apiRequest(`${base(connectionId)}/writes/lock`, writesStatusResponseSchema, {
    method: "POST",
    body: {},
  });
  return unwrap(result, (d) => d.writes);
}

/** What the row editor needs to know about a table (catalog only). */
export async function getEditInfo(
  connectionId: string,
  schema: string,
  table: string,
): Promise<ApiResult<TableEditInfo>> {
  const result = await apiRequest(
    `${base(connectionId)}/writes/edit-info`,
    editInfoResponseSchema,
    {
      method: "POST",
      body: { schema, table },
    },
  );
  return unwrap(result, (d) => d.info);
}

/** Check a change and get the exact statement, its effect and warnings. Nothing is changed. */
export async function requestPreview(
  connectionId: string,
  change: Change,
): Promise<ApiResult<ChangePreview>> {
  const result = await apiRequest(
    `${base(connectionId)}/writes/preview`,
    previewChangeResponseSchema,
    { method: "POST", body: { change }, maxBodyBytes: IMPORT_MAX_BODY_BYTES },
  );
  return unwrap(result, (d) => d.preview);
}

/** Run a previewed change, by its id only. */
export async function requestApply(
  connectionId: string,
  previewId: string,
  /**
   * Aborting it cancels a change of several statements (an import, a bulk change) between them, and everything is
   * rolled back. A change of one statement may still commit on the server after the abort: the client drops the
   * answer, so reload the table to see it.
   */
  signal?: AbortSignal,
): Promise<
  ApiResult<{
    rowCount: number;
    entry: HistoryEntry;
    split?: { inserted: number; updated: number; exact: boolean };
  }>
> {
  const result = await apiRequest(`${base(connectionId)}/writes/apply`, applyChangeResponseSchema, {
    method: "POST",
    body: { previewId },
    ...(signal ? { signal } : {}),
  });
  return unwrap(result, (d) => d.result);
}

/** The changes made since connecting (names only, never values). */
export async function getWritesHistory(connectionId: string): Promise<ApiResult<HistoryEntry[]>> {
  const result = await apiRequest(`${base(connectionId)}/writes/history`, historyResponseSchema);
  return unwrap(result, (d) => d.history);
}

/** The changes of structure made since connecting, as one SQL script (row changes only counted). */
export async function getWritesMigration(connectionId: string): Promise<ApiResult<MigrationFile>> {
  const result = await apiRequest(
    `${base(connectionId)}/writes/migration`,
    migrationResponseSchema,
  );
  return unwrap(result, (d) => d.migration);
}

/** What the connected database role can do, and the warnings for reading and for writing. */
export function getRole(connectionId: string): Promise<ApiResult<RoleResponse>> {
  return apiRequest(`${base(connectionId)}/role`, roleResponseSchema);
}
