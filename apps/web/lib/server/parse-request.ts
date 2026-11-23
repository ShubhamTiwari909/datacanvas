/**
 * Safe parsing of JSON request bodies for route handlers.
 *
 * Everything that arrives over HTTP is untrusted: it may be too large, not
 * JSON, or JSON of the wrong shape. TypeScript types do not exist at runtime,
 * so a Zod schema is the only thing that actually checks the shape. This
 * helper runs the checks in a fixed order and turns each failure into the
 * standard error response:
 *
 *   1. Content-Type must be application/json          -> 415 unsupported_media_type
 *   2. Body must be at most `maxBytes`                -> 413 payload_too_large
 *   3. Body must be valid JSON                        -> 400 invalid_json
 *   4. JSON must match the schema                     -> 400 validation_error
 *
 * Usage in a route handler:
 *
 *   const parsed = await parseJsonBody(request, someSchema);
 *   if (!parsed.ok) return parsed.response;   // already a complete error response
 *   // parsed.data is now fully typed AND verified
 */
import type { ValidationIssue } from "@datacanvas/shared-types";
import type { z } from "zod";
import { errorResponse } from "./api-response";

/** Largest body we accept. Connection details are tiny; anything bigger is suspicious. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** Return at most this many issues, so a hostile payload cannot make a huge response. */
const MAX_ISSUES = 20;

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: Response };

/**
 * Read the request body as text, giving up once it exceeds `maxBytes`.
 *
 * We read the stream chunk by chunk instead of calling `request.text()`,
 * because a client can omit or lie about Content-Length and stream gigabytes.
 * Returns null when the limit is exceeded.
 */
async function readTextWithLimit(
  request: Request,
  maxBytes: number,
): Promise<{ text: string; bytes: number } | null> {
  if (!request.body) return { text: "", bytes: 0 };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel(); // stop reading; discard the rest
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), bytes: total };
}

/** Convert Zod issues into the API's `{ path, message }` list. Messages never echo the input. */
export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<ParsedBody<z.output<S>>> {
  // Requiring JSON also helps against cross-site form posts: a plain HTML
  // <form> cannot send this content type without a CORS preflight.
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return {
      ok: false,
      response: errorResponse(
        "unsupported_media_type",
        "Send the body as JSON with the header Content-Type: application/json.",
        415,
      ),
    };
  }

  // Cheap early rejection when the client declares a huge body up front.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: tooLarge(maxBytes) };
  }

  const read = await readTextWithLimit(request, maxBytes);
  if (read === null) return { ok: false, response: tooLarge(maxBytes) };
  const { text, bytes } = read;
  // A body shorter than the client said it was has been cut on the way (the framework keeps a limited part of a large
  // body): say so, rather than "not valid JSON" about a request that was fine.
  // (The bytes counted as they were read: re-encoding the text would miss a BOM the decoder strips.)
  if (Number.isFinite(declared) && declared > 0 && bytes < declared) {
    return { ok: false, response: tooLarge(maxBytes) };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: errorResponse("invalid_json", "The request body is not valid JSON.", 400),
    };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      response: errorResponse(
        "validation_error",
        "The request is not valid. See the issues for details.",
        400,
        toValidationIssues(result.error),
      ),
    };
  }
  return { ok: true, data: result.data };
}

function tooLarge(maxBytes: number): Response {
  return errorResponse(
    "payload_too_large",
    `The request body is larger than the ${maxBytes >= 1024 * 1024 ? `${Math.round((maxBytes / (1024 * 1024)) * 10) / 10} MB` : `${Math.round(maxBytes / 1024)} KB`} limit, or was cut short on the way.`,
    413,
  );
}
