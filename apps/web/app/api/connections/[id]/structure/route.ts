/**
 * GET /api/connections/:id/structure
 *
 * The whole live structure of the database (schemas, tables with columns,
 * constraints and indexes, and foreign keys), in the same shape a snapshot
 * stores. Nothing is saved; this is what "compare with the live database"
 * reads. Structure only: never table rows.
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const { structure } = await getServerContext().connections.captureStructure(id);
    return jsonResponse({ structure });
  });
}
