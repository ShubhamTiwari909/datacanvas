/**
 * The call of the SQL view. Components use this, never `fetch`.
 *
 * The body is JSON, so the text of a statement never appears in a URL, the browser history or
 * a server log. The SQL runner keeps its result in memory and drops
 * it with the connection. Aborting the signal cancels the statement in the database.
 */
import {
  MAX_SAVED_QUERY_BODY_BYTES,
  savedQueryListSchema,
  savedQuerySchema,
  sqlRunResponseSchema,
  type EditSavedQueryRequest,
  type SaveQueryRequest,
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

function savedQueriesPath(connectionId: string, queryId?: string): string {
  const path = `/api/connections/${encodeURIComponent(connectionId)}/saved-queries`;
  return queryId === undefined ? path : `${path}/${encodeURIComponent(queryId)}`;
}

export function listSavedQueries(connectionId: string) {
  return apiRequest(savedQueriesPath(connectionId), savedQueryListSchema);
}

export function getSavedQuery(connectionId: string, queryId: string) {
  return apiRequest(savedQueriesPath(connectionId, queryId), savedQuerySchema);
}

export function saveQuery(connectionId: string, input: SaveQueryRequest) {
  return apiRequest(savedQueriesPath(connectionId), savedQueryListSchema, {
    method: "POST",
    body: input,
    maxBodyBytes: MAX_SAVED_QUERY_BODY_BYTES,
  });
}

export function editSavedQuery(
  connectionId: string,
  queryId: string,
  input: EditSavedQueryRequest,
) {
  return apiRequest(savedQueriesPath(connectionId, queryId), savedQueryListSchema, {
    method: "PUT",
    body: input,
    maxBodyBytes: MAX_SAVED_QUERY_BODY_BYTES,
  });
}

export function deleteSavedQuery(connectionId: string, queryId: string) {
  return apiRequest(savedQueriesPath(connectionId, queryId), savedQueryListSchema, {
    method: "DELETE",
  });
}
