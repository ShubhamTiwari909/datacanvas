/**
 * Turn any error thrown while handling a request into the standard JSON error
 * response. Route handlers call `handleRoute(...)` and never write try/catch.
 *
 * SECURITY: only the error CODE and our own fixed message are ever returned,
 * and only the code (never a message or stack) is logged for unexpected
 * failures. Raw driver errors can contain host names, user names and SQL.
 */
import { isDatabaseError, type DatabaseErrorCode } from "@datacanvas/database-core";
import { guardRequest } from "../security/request-guard";
import { errorResponse } from "./api-response";
import { ServiceError } from "./service-error";

/**
 * HTTP status for each database failure.
 *  - 400: the request was fine but the connection details are wrong
 *         (credentials, database name, TLS setting, privileges);
 *  - 404: the schema or table does not exist;
 *  - 409: the connection is not open;
 *  - 502 / 504: the database server could not be reached / did not answer in time
 *         (we are a gateway to it);
 *  - 500: anything we did not anticipate.
 */
export const DATABASE_ERROR_STATUS: Record<DatabaseErrorCode, number> = {
  authentication_failed: 400,
  database_not_found: 400,
  ssl_error: 400,
  permission_denied: 400,
  not_found: 404,
  not_connected: 409,
  invalid_request: 400,
  not_supported: 400,
  unreachable: 502,
  timeout: 504,
  unexpected: 500,
};

const SERVICE_ERROR_STATUS = {
  connection_not_found: 404,
  connection_limit_reached: 409,
  profile_not_found: 404,
  workspace_not_found: 404,
  workspace_limit_reached: 409,
  invalid_workspace_file: 400,
  data_access_disabled: 403,
  rows_busy: 429,
  snapshot_not_found: 404,
  snapshot_limit_reached: 409,
  snapshot_too_large: 413,
  invalid_snapshot_file: 400,
  storage_error: 500,
} as const;

/** A log-safe description: names and codes only, never messages (they may hold secrets). */
function describeForLog(error: unknown): string {
  if (typeof error !== "object" || error === null) return typeof error;
  const cause = (error as { cause?: unknown }).cause;
  const codeOf = (value: unknown): string =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string"
      ? (value as { code: string }).code
      : "-";
  const name = (error as { name?: unknown }).name;
  return `${typeof name === "string" ? name : "error"} code=${codeOf(error)} causeCode=${codeOf(cause)}`;
}

export function toErrorResponse(error: unknown): Response {
  if (error instanceof ServiceError) {
    if (error.code === "storage_error") {
      console.error(`[datacanvas] storage error: ${describeForLog(error)}`);
    }
    return errorResponse(error.code, error.message, SERVICE_ERROR_STATUS[error.code]);
  }
  if (isDatabaseError(error)) {
    if (error.code === "unexpected") {
      console.error(`[datacanvas] unexpected database error: ${describeForLog(error)}`);
    }
    return errorResponse(error.code, error.message, DATABASE_ERROR_STATUS[error.code]);
  }
  console.error(`[datacanvas] unexpected error: ${describeForLog(error)}`);
  return errorResponse("unexpected", "An unexpected error occurred.", 500);
}

/**
 * Run a handler body; any error becomes a standard error response.
 *
 * It first re-checks the request with the same rules as `proxy.ts` (Host,
 * Origin, session token). That duplication is deliberate: if the proxy is ever
 * bypassed or misconfigured, no route can run without passing the guard.
 */
export async function handleRoute(
  request: Request,
  work: () => Promise<Response>,
): Promise<Response> {
  const refused = guardRequest(request, errorResponse);
  if (refused) return refused;
  try {
    return await work();
  } catch (error) {
    return toErrorResponse(error);
  }
}
