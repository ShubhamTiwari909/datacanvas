/**
 * GET /api/connections/:id/tables/:table?schema=public
 *
 * Everything the table detail panel needs in one round trip: columns,
 * constraints and indexes. (This replaces separate /columns, /constraints and
 * /indexes endpoints, which would cost the UI three requests per click.)
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
  return handleRoute(async () => {
    const query = parseQuery(request, schemaQuerySchema);
    if (!query.ok) return query.response;

    const { id, table } = await params;
    // Next.js already decoded the path segment (a table "my%20table" arrives as "my table").
    if (!identifierSchema.safeParse(table).success) {
      return errorResponse("validation_error", "The table name is not valid.", 400);
    }

    const details = await getServerContext().connections.getTableDetails(
      id,
      query.data.schema,
      table,
    );
    return jsonResponse(details);
  });
}
