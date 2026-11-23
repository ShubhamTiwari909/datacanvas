/**
 * POST /api/connections/:id/rows/preflight
 *
 * Body: `{ checks: [{ kind: "nulls" | "duplicates" | "orphans" | "rows", ...names }] }`. How many rows
 * of THIS database would make steps of a migration fail (a `SET NOT NULL`, a unique key, a foreign key, a
 * column that cannot be NULL), before the script is run. Four fixed read-only queries, built from names
 * that are checked against the catalog; only counts come back (decision 157).
 *
 * Refused (403 `data_access_disabled`) unless viewing table data was switched on for this connection: a
 * count says how the data is. Like the route for a page: a JSON body, a strict schema, a `no-store`
 * response, and no value anywhere.
 */
import { preflightRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, preflightRequestSchema);
    if (!parsed.ok) return parsed.response;
    const results = await getServerContext().connections.preflight(id, parsed.data);
    return jsonResponse({ results });
  });
}
