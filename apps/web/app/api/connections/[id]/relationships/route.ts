/** GET /api/connections/:id/relationships: every confirmed foreign key in the database. */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(_request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(async () => {
    const { id } = await params;
    const relationships = await getServerContext().connections.getRelationships(id);
    return jsonResponse({ relationships });
  });
}
