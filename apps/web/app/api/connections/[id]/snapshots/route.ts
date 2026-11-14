/**
 * POST /api/connections/:id/snapshots
 *
 * Body: `{ name? }`. Reads the database's structure on the server and saves it
 * as a snapshot (the browser never supplies the structure). Answers 201 with
 * the snapshot's summary.
 */
import { createSnapshotInputSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, createSnapshotInputSchema);
    if (!parsed.ok) return parsed.response;
    const snapshot = await getServerContext().snapshots.create(id, parsed.data);
    return jsonResponse({ snapshot }, 201);
  });
}
