/**
 * DELETE /api/profiles/:id
 *
 * Forgets a saved connection AND deletes the workspaces saved for it. (A live
 * connection that was opened from this profile keeps working until it is
 * disconnected; it just is no longer linked to saved data.)
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
    const context = getServerContext();
    await context.profiles.remove(id);
    context.connections.unlinkProfile(id); // live connections opened from it stay open, just unlinked
    return jsonResponse({ ok: true });
  });
}
