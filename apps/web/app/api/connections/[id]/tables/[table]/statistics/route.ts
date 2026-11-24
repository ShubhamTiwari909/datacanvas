/**
 * GET /api/connections/:id/tables/:table/statistics?schema=public
 *
 * What the server's own statistics say about one table: the share of NULLs, the number of distinct values, the width
 * and the order of each column, the size of the table, its indexes and its TOAST data, and when it was last vacuumed
 * and analysed. **No row and no value is read** (the statistics that hold values are never selected), so this needs
 * no "Allow viewing table data", like the row-count estimate. `statistics` is null for a view or a foreign table.
 */
import { identifierSchema, schemaQuerySchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { errorResponse } from "@/lib/server/api-response";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, parseQuery, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(
  request: Request,
  { params }: RouteParams<{ id: string; table: string }>,
): Promise<Response> {
  return handleRoute(request, async () => {
    const query = parseQuery(request, schemaQuerySchema);
    if (!query.ok) return query.response;
    const { id, table } = await params;
    if (!identifierSchema.safeParse(table).success) {
      return errorResponse("validation_error", "The table name is not valid.", 400);
    }
    const statistics = await getServerContext().connections.getTableStatistics(
      id,
      query.data.schema,
      table,
    );
    return jsonResponse({ statistics });
  });
}
