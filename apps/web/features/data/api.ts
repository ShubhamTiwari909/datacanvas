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
  type CellRequestBody,
  type ConnectionSummary,
  type RowsRequest,
} from "@datacanvas/shared-types";
import type { CellRead, RowPage } from "@datacanvas/database-core";
import { apiRequest, type ApiResult } from "@/lib/api-client";

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
