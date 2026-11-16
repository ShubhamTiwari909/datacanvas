/**
 * POST /api/connections/:id/writes/lock
 *
 * Body: `{}`. Locks writes for this connection again and drops its pending
 * previews. Answers `{ writes }` (the four switches). A JSON body is required,
 * like every other state-changing route, so a plain HTML form cannot reach it.
 */
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const lockRequestSchema = z.strictObject({});

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, lockRequestSchema);
    if (!parsed.ok) return parsed.response;
    const writes = getServerContext().writes.lock(id);
    return jsonResponse({ writes });
  });
}
