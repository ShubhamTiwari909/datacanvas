/**
 * The browser's single way of calling the DataCanvas API.
 *
 * `apiRequest` NEVER throws. It returns either `{ ok: true, data }` (data
 * already verified against a Zod schema) or `{ ok: false, error }` with a code
 * and a message that are safe to show. Network failures, unreadable bodies,
 * unexpected shapes and server-reported errors all arrive the same way, so UI
 * code has exactly one failure path to handle.
 */
import { apiErrorResponseSchema, type ValidationIssue } from "@datacanvas/shared-types";
import type { z } from "zod";

export interface ApiFailure {
  /** Stable code: a server error code such as "authentication_failed", or "network_error" / "bad_response". */
  code: string;
  message: string;
  /** Per-field problems for validation errors; empty otherwise. */
  issues: ValidationIssue[];
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

function failure(code: string, message: string, issues: ValidationIssue[] = []): ApiResult<never> {
  return { ok: false, error: { code, message, issues } };
}

export async function apiRequest<S extends z.ZodType>(
  path: string,
  schema: S,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    /** Aborting it stops the request (and, for a running statement, the server cancels it). */
    signal?: AbortSignal;
  } = {},
): Promise<ApiResult<z.output<S>>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return failure("aborted", "The request was cancelled.");
    }
    return failure("network_error", "Could not reach the DataCanvas server. Is it still running?");
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    // Cancelling while the body is read is still a cancel.
    if (options.signal?.aborted) return failure("aborted", "The request was cancelled.");
    return failure("bad_response", "The server sent an unreadable response.");
  }

  if (response.ok) {
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, data: parsed.data };
    return failure("bad_response", "The server sent an unexpected response.");
  }

  const error = apiErrorResponseSchema.safeParse(json);
  if (error.success) {
    return failure(error.data.error.code, error.data.error.message, error.data.error.issues ?? []);
  }
  return failure("bad_response", `The request failed (HTTP ${response.status}).`);
}
