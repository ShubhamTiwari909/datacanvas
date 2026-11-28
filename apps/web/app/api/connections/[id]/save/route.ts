/**
 * POST /api/connections/:id/save
 *
 * Saves a live connection's NON-SECRET details (host, port, database, user,
 * SSL mode) as a profile, so it appears in the saved list after a restart. The
 * password is never saved. Answers with the connection's updated summary
 * (which now has a `profileId`).
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const context = getServerContext();
    const connection = await context.savedQueries.promoteConnection(id, context.connections);
    return jsonResponse({ connection });
  });
}
