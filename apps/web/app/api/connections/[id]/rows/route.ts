/**
 * POST /api/connections/:id/rows
 *
 * Body: `{ schema, table, pageSize?, cursor?, revealColumns?, sort?, filters? }`. One
 * bounded page of a table's ROWS, read-only, optionally sorted by one column and
 * narrowed by up to three conditions. Refused (403 `data_access_disabled`) unless
 * viewing table data was switched on for this connection.
 *
 * This is the one route that returns table data, so: the body is JSON (names and
 * paging positions never appear in a URL, the history or a log), the schema is
 * strict (no `where`, `orderBy` or `sql` key exists; a sort and conditions are
 * structured and every value in them stays a value), the response is `no-store`,
 * and no value (a cell, a paging position or the value of a condition) is ever
 * logged or echoed in an error.
 */
import { rowsRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, rowsRequestSchema);
    if (!parsed.ok) return parsed.response;
    const page = await getServerContext().connections.getRows(id, parsed.data);
    return jsonResponse({ page });
  });
}
