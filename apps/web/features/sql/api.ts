/**
 * The call of the SQL view. Components use this, never `fetch`.
 *
 * The body is JSON, so the text of a statement never appears in a URL, the browser history or
 * a server log. Nothing returned here is stored: the store keeps one result in memory and drops
 * it with the connection. Aborting the signal cancels the statement in the database.
 */
import {
  sqlRunResponseSchema,
  type SqlRunRequestInput,
  type SqlRunResponse,
} from "@datacanvas/shared-types";
import { apiRequest, type ApiResult } from "@/lib/api-client";

/** Run one statement. A statement the database refused comes back as `{ failure }` (an answer, not an error). */
export function runStatement(
  connectionId: string,
  request: SqlRunRequestInput,
  signal?: AbortSignal,
): Promise<ApiResult<SqlRunResponse>> {
  return apiRequest(
    `/api/connections/${encodeURIComponent(connectionId)}/run`,
    sqlRunResponseSchema,
    {
      method: "POST",
      body: request,
      signal,
    },
  );
}
