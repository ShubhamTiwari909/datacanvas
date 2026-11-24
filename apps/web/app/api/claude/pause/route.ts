/**
 * PUT /api/claude/pause
 *
 * `{ paused: boolean }`. While paused every call of Claude is refused at once (and the waiting approvals are denied);
 * resuming lets the next call through. The pause is in memory and ends with the sharing.
 */
import { claudePauseRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PUT(request: Request): Promise<Response> {
  return handleRoute(request, async () => {
    const parsed = await parseJsonBody(request, claudePauseRequestSchema);
    if (!parsed.ok) return parsed.response;
    const mcp = getServerContext().mcp;
    mcp.setPaused(parsed.data.paused);
    return jsonResponse({ paused: mcp.control.paused });
  });
}
