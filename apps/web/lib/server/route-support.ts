/**
 * Small helpers shared by the /api/connections route handlers.
 */
import type { z } from "zod";
import { errorResponse } from "./api-response";
import { toValidationIssues } from "./parse-request";

/** Second argument of a dynamic route handler such as `/api/connections/[id]`. Params arrive as a Promise. */
export type RouteParams<T extends Record<string, string>> = { params: Promise<T> };

/** 200 JSON response that must never be cached. */
export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Validate the query string with a Zod schema, the same way request bodies are
 * validated: either typed data, or a ready-made 400 response.
 */
export function parseQuery<S extends z.ZodType>(
  request: Request,
  schema: S,
): { ok: true; data: z.output<S> } | { ok: false; response: Response } {
  const result = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (result.success) return { ok: true, data: result.data };
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
