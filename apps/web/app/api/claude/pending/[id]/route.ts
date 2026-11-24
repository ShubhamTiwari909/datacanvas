/**
 * POST /api/claude/pending/:id
 *
 * Approve or deny a call of Claude that waits (`{ decision: "approve" | "deny" }`). A call that was already answered, or
 * timed out, or was given up by the client, is gone: 404. Nothing runs before the person approves.
 */
import { claudeDecisionRequestSchema } from "@datacanvas/shared-types";
import { errorResponse } from "@/lib/server/api-response";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, claudeDecisionRequestSchema);
    if (!parsed.ok) return parsed.response;
    if (!getServerContext().mcp.control.decide(id, parsed.data.decision)) {
      return errorResponse("not_found", "That request is no longer waiting.", 404);
    }
    return jsonResponse({ ok: true });
  });
}
