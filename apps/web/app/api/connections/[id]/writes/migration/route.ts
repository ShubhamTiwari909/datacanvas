/**
 * GET /api/connections/:id/writes/migration
 *
 * The changes of structure made through this connection since it was opened,
 * as one SQL script: `{ migration: { filename, sql, steps, rowChanges } }`.
 * Row changes are only counted, never written (decisions 131 and 138). Held in
 * server memory and gone when the connection is closed.
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const migration = getServerContext().writes.migration(id);
    return jsonResponse({ migration });
  });
}
