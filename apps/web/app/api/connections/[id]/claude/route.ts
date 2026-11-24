/**
 * GET and PUT /api/connections/:id/claude
 *
 * Share this connection with Claude through MCP, or stop (decision 169). `{ level: "off" | "structure" | "data" }`. The data
 * level needs viewing table data to be on (`data_access_disabled` otherwise). In MEMORY only: never saved with a profile,
 * gone on restart and on disconnect. Like data viewing this is consent and a speed bump, not protection against someone who
 * holds the session token: the Host, Origin and token checks are the boundary.
 */
import { claudeSharingRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    return jsonResponse({ sharing: { level: getServerContext().mcp.levelOf(id) } });
  });
}

export function PUT(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, claudeSharingRequestSchema);
    if (!parsed.ok) return parsed.response;
    const level = getServerContext().mcp.share(id, parsed.data.level);
    return jsonResponse({ sharing: { level } });
  });
}
