/** GET /api/workspaces[?profileId=...]: summaries of the saved workspaces, most recently changed first. */
import { workspaceListQuerySchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, parseQuery } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleRoute(request, async () => {
    const query = parseQuery(request, workspaceListQuerySchema);
    if (!query.ok) return query.response;
    const workspaces = await getServerContext().workspaces.list(query.data.profileId);
    return jsonResponse({ workspaces });
  });
}
