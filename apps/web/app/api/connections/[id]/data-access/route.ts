/**
 * PUT /api/connections/:id/data-access
 *
 * Body: `{ enabled: boolean }`. Switch viewing table data on or off for this
 * connection; the choice is remembered with its saved connection, if it has one.
 * Answers with the updated connection summary.
 *
 * This is consent and a speed bump, not protection against someone who already
 * holds the session token (they can switch it on): the Host, Origin and token
 * checks are the real boundary.
 */
import { dataAccessRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PUT(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, dataAccessRequestSchema);
    if (!parsed.ok) return parsed.response;
    const connection = await getServerContext().connections.setDataAccess(id, parsed.data.enabled);
    return jsonResponse({ connection });
  });
}
