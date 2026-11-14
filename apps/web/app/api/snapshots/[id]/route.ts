/**
 * /api/snapshots/:id
 *
 *   GET     the full snapshot, structure included
 *   DELETE  delete it
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    return jsonResponse({ snapshot: await getServerContext().snapshots.get(id) });
  });
}

export function DELETE(
  request: Request,
  { params }: RouteParams<{ id: string }>,
): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    await getServerContext().snapshots.remove(id);
    return jsonResponse({ ok: true });
  });
}
