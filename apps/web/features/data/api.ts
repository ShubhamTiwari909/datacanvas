/**
 * Calls for viewing table data. Components use these, never `fetch`.
 *
 * Both are JSON bodies, so table names and paging positions never appear in a
 * URL, the browser history or a server log. Nothing returned here is stored:
 * callers keep a page in component state and drop it when they unmount.
 */
import {
  connectionResponseSchema,
  rowsResponseSchema,
  type ConnectionSummary,
  type RowsRequest,
} from "@datacanvas/shared-types";
import type { RowPage } from "@datacanvas/database-core";
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
