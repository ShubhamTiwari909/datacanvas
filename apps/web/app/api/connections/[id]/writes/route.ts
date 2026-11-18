/**
 * GET /api/connections/:id/writes
 *
 * Whether changes are possible on this connection, as four switches that must
 * all be on: `enabled` (DataCanvas was started with `--enable-writes`),
 * `local` (the connection's host is this machine), `dataAccess` (viewing table
 * data is on) and `unlocked` (the person unlocked writes for this connection in
 * this session). Answers `{ writes: { enabled, local, dataAccess, unlocked } }`.
 * Reads nothing from the database.
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const writes = getServerContext().writes.status(id);
    return jsonResponse({ writes });
  });
}
