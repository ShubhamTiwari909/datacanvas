/**
 * POST /api/connections/:id/writes/apply
 *
 * Body: `{ previewId }`, and nothing else: the change itself stays on the
 * server, so exactly what was previewed runs. The preview is used up (single
 * use); one change runs at a time per connection (`write_busy` otherwise). It
 * runs in one read-write transaction with a 3 second lock timeout; a row
 * change must touch exactly one row or everything rolls back.
 *
 * Answers `{ result: { rowCount, entry } }`, where `entry` is the new line of
 * the session history (names only, never values). Errors carry fixed
 * messages chosen by SQLSTATE, never the database's own text.
 */
import { applyChangeRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, applyChangeRequestSchema);
    if (!parsed.ok) return parsed.response;
    const result = await getServerContext().writes.apply(id, parsed.data.previewId, request.signal);
    return jsonResponse({ result });
  });
}
