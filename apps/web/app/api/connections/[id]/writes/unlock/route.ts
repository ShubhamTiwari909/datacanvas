/**
 * POST /api/connections/:id/writes/unlock
 *
 * Body: `{ database: string }`, the connection's database name typed by the
 * person. Unlocks writes for this connection until it is locked, disconnected,
 * data viewing is switched off, or DataCanvas stops (memory only, never saved).
 * Answers `{ writes }` (the four switches).
 *
 * Refused, in this order: `writes_not_enabled` (started without
 * `--enable-writes`), `writes_not_allowed_here` (not a database on this
 * machine), `data_access_disabled`, `wrong_database_name`. The refusal never
 * repeats what was typed.
 */
import { unlockWritesRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, unlockWritesRequestSchema);
    if (!parsed.ok) return parsed.response;
    const writes = getServerContext().writes.unlock(id, parsed.data.database);
    return jsonResponse({ writes });
  });
}
