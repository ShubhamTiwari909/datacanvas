/**
 * GET /api/connections/:id/index-usage
 *
 * How often each index of the ordinary tables has been used, from the server's
 * statistics counters, with when they were last reset and whether the server is
 * a standby. Counters only: this route reads no table rows.
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const usage = await getServerContext().connections.getIndexUsage(id);
    return jsonResponse({ usage });
  });
}
