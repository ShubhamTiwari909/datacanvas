/**
 * POST /api/connections/:id/rows/cell
 *
 * Body: `{ schema, table, column, key: [{ column, value }], revealColumns? }`. ONE `json` or `jsonb`
 * value of ONE row, read whole (up to 1 MB), for the JSON editor; a page of rows cuts every cell
 * short. Refused (403 `data_access_disabled`) unless viewing table data was switched on for this
 * connection, exactly like the route for a page.
 *
 * Like that route: the body is JSON (names and key values never appear in a URL, the history or a
 * log), the schema is strict, the response is `no-store`, and no value is ever logged or echoed in
 * an error.
 */
import { cellRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, cellRequestSchema);
    if (!parsed.ok) return parsed.response;
    const cell = await getServerContext().connections.getCell(id, parsed.data);
    return jsonResponse({ cell });
  });
}
