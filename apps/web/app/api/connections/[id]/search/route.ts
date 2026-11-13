/**
 * GET /api/connections/:id/search?q=order&limit=20
 *
 * Finds tables, views and columns whose NAME contains `q`, anywhere in the
 * database. Searches names only, never data. See `searchObjects` in
 * @datacanvas/database-core for the exact rules (case-insensitive, `%` and `_`
 * are literal, ranked, capped).
 */
import { searchQuerySchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, parseQuery, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const query = parseQuery(request, searchQuerySchema);
    if (!query.ok) return query.response;

    const { id } = await params;
    const hits = await getServerContext().connections.search(id, query.data.q, query.data.limit);
    return jsonResponse({ hits });
  });
}
