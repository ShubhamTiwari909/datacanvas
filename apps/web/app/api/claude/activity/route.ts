/**
 * GET /api/claude/activity
 *
 * What the person sees while Claude reads (decision 169): the connections shared and how, the calls that wait for Approve,
 * the pause, and the list of what Claude asked. In memory; the list holds the request (a statement, a table) and counts of
 * what came back, never a returned value. Behind the cookie guard like every `/api` route.
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleRoute(request, async () => jsonResponse(getServerContext().mcp.snapshot()));
}
