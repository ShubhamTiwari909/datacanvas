/** GET /api/connections/:id/tables?schema=public: tables, views and materialized views of a schema. */
import { schemaQuerySchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, parseQuery, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const query = parseQuery(request, schemaQuerySchema);
    if (!query.ok) return query.response;

    const { id } = await params;
    const tables = await getServerContext().connections.getTables(id, query.data.schema);
    return jsonResponse({ tables });
  });
}
