/**
 * GET /api/connections/:id/writes/history
 *
 * The changes made through this connection since it was opened, newest first:
 * `{ history: [{ id, at, kind, table, columns, statement, outcome, errorCode }] }`.
 * Names only, never values; `statement` is set for a change of structure only.
 * Held in server memory and gone when the connection is closed (decision 131).
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const history = getServerContext().writes.history(id);
    return jsonResponse({ history });
  });
}
