/**
 * DELETE /api/connections/:id
 *
 * Disconnects and forgets a connection, discarding its credentials from memory.
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function DELETE(
  request: Request,
  { params }: RouteParams<{ id: string }>,
): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    await getServerContext().connections.deleteConnection(id);
    return jsonResponse({ ok: true });
  });
}
