/**
 * Helpers that build JSON responses for route handlers, so every route returns
 * the same shapes. Server-only code: import it from `app/api/**` only.
 *
 * Uses the standard Web `Response` (not `NextResponse`) so these helpers also
 * work in plain unit tests without a Next.js runtime.
 */
import type { ApiErrorCode, ApiErrorResponse, ValidationIssue } from "@datacanvas/shared-types";

/**
 * Build the standard JSON error response:
 * `{ "error": { "code", "message", "issues"? } }`.
 *
 * @param code    Stable machine-readable identifier, e.g. "not_found".
 * @param message Safe human-readable sentence. Never include secrets or raw errors.
 * @param status  HTTP status code (400, 404, 413, ...).
 * @param issues  Optional per-field problems (for validation errors).
 */
export function errorResponse(
  code: ApiErrorCode,
  message: string,
  status: number,
  issues?: ValidationIssue[],
): Response {
  const body: ApiErrorResponse = {
    error: { code, message, ...(issues ? { issues } : {}) },
  };
  // no-store: API answers describe live state and must never be cached.
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
