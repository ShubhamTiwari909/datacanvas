/**
 * POST /api/connections/:id/table-details
 *
 * Description, columns, constraints and indexes of MANY tables in one request,
 * for the canvas. Body: `{ "tables": [{ "schema": "public", "name": "users" }, ...] }`
 * (1 to 500 tables). Answer: `{ "tables": [...] }` in request order.
 *
 * It is a POST although it only reads: the list of tables does not fit
 * comfortably in a URL. Nothing is changed by calling it. If any table does not
 * exist the whole call fails with 404 `not_found`.
 */
import { tablesDetailsRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const parsed = await parseJsonBody(request, tablesDetailsRequestSchema);
    if (!parsed.ok) return parsed.response;

    const { id } = await params;
    const tables = await getServerContext().connections.getTablesDetails(id, parsed.data.tables);
    return jsonResponse({ tables });
  });
}
