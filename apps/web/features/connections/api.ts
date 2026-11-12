/**
 * Browser-side functions that call the DataCanvas API.
 *
 * Components never call `fetch` directly; they use these functions, which
 * return plain, already-verified results. Responses are checked with the same
 * Zod schemas the server uses, so a malformed answer becomes an error result
 * instead of a crash further down.
 */
import {
  apiErrorResponseSchema,
  validateConnectionResponseSchema,
  type PostgresConnectionSummary,
  type ValidationIssue,
} from "@datacanvas/shared-types";

export type ValidateConnectionResult =
  | { ok: true; connection: PostgresConnectionSummary }
  | { ok: false; message: string; issues: ValidationIssue[] };

/** Same-origin request to a JSON endpoint. Never throws; failures become results. */
export async function validateConnection(input: unknown): Promise<ValidateConnectionResult> {
  let response: Response;
  try {
    response = await fetch("/api/connections/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
  } catch {
    return { ok: false, message: "Could not reach the DataCanvas server.", issues: [] };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, message: "The server sent an unreadable response.", issues: [] };
  }

  if (response.ok) {
    const parsed = validateConnectionResponseSchema.safeParse(body);
    if (parsed.success) return { ok: true, connection: parsed.data.connection };
    return { ok: false, message: "The server sent an unexpected response.", issues: [] };
  }

  const error = apiErrorResponseSchema.safeParse(body);
  if (error.success) {
    return {
      ok: false,
      message: error.data.error.message,
      issues: error.data.error.issues ?? [],
    };
  }
  return { ok: false, message: `The request failed (HTTP ${response.status}).`, issues: [] };
}
