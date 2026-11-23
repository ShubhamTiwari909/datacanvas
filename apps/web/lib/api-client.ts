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
    /** The most the server takes in a body; a larger request is refused here, in plain words, instead of sent. */
    maxBodyBytes?: number;
  } = {},
): Promise<ApiResult<z.output<S>>> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (
    body !== undefined &&
    options.maxBodyBytes !== undefined &&
    new TextEncoder().encode(body).byteLength > options.maxBodyBytes
  ) {
    return failure(
      "payload_too_large",
      `This is more than DataCanvas can send in one request (${Math.round(options.maxBodyBytes / (1024 * 1024))} MB as it is sent, which is more than the file itself because every field is quoted). Import fewer rows or columns, or split the file.`,
    );
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body,
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

/**
 * Call an endpoint whose answer is a FILE (the export of rows), read as a stream so the page can show how much has
 * arrived and a cancel stops it. Like `apiRequest` it never throws: a failure, including one that the server knew
 * before the first byte (an ordinary JSON error), arrives as `{ ok: false, error }`.
 */
export async function apiDownload(
  path: string,
  options: {
    body: unknown;
    signal?: AbortSignal;
    /** Called with the bytes received so far. */
    onProgress?: (bytes: number) => void;
  },
): Promise<ApiResult<{ blob: Blob; bytes: number }>> {
  const cancelled = () => failure("aborted", "The export was cancelled.");
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.body),
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return cancelled();
    }
    return failure("network_error", "Could not reach the DataCanvas server. Is it still running?");
  }
  if (!response.ok) {
    try {
      const error = apiErrorResponseSchema.safeParse(await response.json());
      if (error.success) {
        return failure(
          error.data.error.code,
          error.data.error.message,
          error.data.error.issues ?? [],
        );
      }
    } catch {
      // Falls through to the plain message.
    }
    return failure("bad_response", `The request failed (HTTP ${response.status}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) return failure("bad_response", "The server sent an unreadable response.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.byteLength;
      options.onProgress?.(bytes);
    }
  } catch {
    if (options.signal?.aborted) return cancelled();
    return failure("network_error", "The file stopped arriving before it was complete.");
  }
  const type = response.headers.get("content-type") ?? "application/octet-stream";
  return { ok: true, data: { blob: new Blob(chunks as BlobPart[], { type }), bytes } };
}
