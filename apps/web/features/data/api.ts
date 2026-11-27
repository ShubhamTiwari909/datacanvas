/**
 * Calls for viewing table data. Components use these, never `fetch`.
 *
 * Both are JSON bodies, so table names and paging positions never appear in a
 * URL, the browser history or a server log. Nothing returned here is stored:
 * callers keep a page in component state and drop it when they unmount.
 */
import {
  cellResponseSchema,
  connectionResponseSchema,
  rowsResponseSchema,
  preflightResponseSchema,
  validateResponseSchema,
  VALIDATE_MAX_BODY_BYTES,
  type CellRequestBody,
  type ExportRequestBody,
  type ConnectionSummary,
  type PreflightRequestBody,
  type RowsRequest,
  type ValidateRequestBody,
} from "@datacanvas/shared-types";
import type {
  CellRead,
  PreflightResult,
  RowPage,
  ValidationReport,
} from "@datacanvas/database-core";
import { apiDownload, apiRequest, type ApiResult } from "@/lib/api-client";

/** One page of a table's rows. Refused with `data_access_disabled` while data access is off. */
export async function getRows(
  connectionId: string,
  request: RowsRequest,
): Promise<ApiResult<RowPage>> {
  const result = await apiRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/rows`,
    rowsResponseSchema,
    { method: "POST", body: request },
  );
  return result.ok ? { ok: true, data: result.data.page } : result;
}

/** One `json` or `jsonb` value of one row, whole (for the JSON editor). Refused with `data_access_disabled` while data access is off. */
export async function getCell(
  connectionId: string,
  request: CellRequestBody,
): Promise<ApiResult<CellRead>> {
  const result = await apiRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/rows/cell`,
    cellResponseSchema,
    { method: "POST", body: request },
  );
  return result.ok ? { ok: true, data: result.data.cell } : result;
}

/**
 * Would the database accept these values? Answered without writing a row; the report holds rules, names,
 * counts and row numbers, never a value. Refused with `data_access_disabled` while data access is off.
 * With `listAll` (an insert only), `issues[].rows` names every failing row unless the report says
 * `stopped_early`: more than 1,000 rows failed. Aborting `signal` answers `aborted`.
 */
export async function validateRows(
  connectionId: string,
  request: ValidateRequestBody,
  signal?: AbortSignal,
): Promise<ApiResult<ValidationReport>> {
  const result = await apiRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/rows/validate`,
    validateResponseSchema,
    { method: "POST", body: request, maxBodyBytes: VALIDATE_MAX_BODY_BYTES, signal },
  );
  return result.ok ? { ok: true, data: result.data.report } : result;
}

/**
 * How many rows of this database would make steps of a migration fail. Only counts come back. Refused with
 * `data_access_disabled` while data access is off.
 */
export async function preflight(
  connectionId: string,
  request: PreflightRequestBody,
): Promise<ApiResult<PreflightResult[]>> {
  const result = await apiRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/rows/preflight`,
    preflightResponseSchema,
    { method: "POST", body: request },
  );
  return result.ok ? { ok: true, data: result.data.results } : result;
}

/** Switch viewing table data on or off for a connection. Answers with its updated summary. */
export async function setDataAccess(
  connectionId: string,
  enabled: boolean,
): Promise<ApiResult<ConnectionSummary>> {
  const result = await apiRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/data-access`,
    connectionResponseSchema,
    { method: "PUT", body: { enabled } },
  );
  return result.ok ? { ok: true, data: result.data.connection } : result;
}

/**
 * The rows of a table as a file (CSV, TSV, JSON or NDJSON), as filtered and sorted on screen. Streamed; a
 * cancel stops the read in the database. Refused with `data_access_disabled` while data access is off.
 */
export function exportRowsFile(
  connectionId: string,
  request: ExportRequestBody,
  options: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {},
): Promise<ApiResult<{ blob: Blob; bytes: number }>> {
  return apiDownload(`/api/connections/${encodeURIComponent(connectionId)}/rows/export`, {
    body: request,
    ...options,
  });
}
