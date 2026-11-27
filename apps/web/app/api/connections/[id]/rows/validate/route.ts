/**
 * POST /api/connections/:id/rows/validate
 *
 * Body: `{ schema, table, mode: "insert" | "update", columns, rows, key?, listAll?, upsertKey? }` (`listAll`:
 * an insert only; every failing row up to 1,000, with a longer deadline. `upsertKey`: an insert only; the
 * import is an upsert keyed by these columns, which must be exactly a primary key or unique constraint of the
 * table and all among `columns`: a row matching an existing row by that key is an update, not a failure, and
 * another unique key fails only on a row other than the one being updated). Would the database accept
 * these values? Answered WITHOUT writing a row: the values go into a temporary copy of the table (no
 * triggers, no foreign keys, no defaults, no indexes) in a transaction that is read-only before the first
 * value goes in and is always rolled back, and uniqueness and foreign keys are asked by read-only queries
 * (decision 157). The answer is a report of rules, names, counts and row numbers, never a value.
 *
 * Refused (403 `data_access_disabled`) unless viewing table data was switched on for this connection:
 * a uniqueness answer says whether a value exists, which is table data. It does not need writes to be
 * unlocked. Like the route for a page: a JSON body (values never appear in a URL or a log), a strict
 * schema, a `no-store` response, and no value in any error.
 */
import { validateRequestSchema, VALIDATE_MAX_BODY_BYTES } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, validateRequestSchema, VALIDATE_MAX_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const report = await getServerContext().connections.validateRows(id, parsed.data);
    return jsonResponse({ report });
  });
}
