/**
 * POST /api/connections/:id/run
 *
 * Body: `{ text, maxRows?, timeoutMs? }`: ONE statement the person typed, run read-only on a
 * connection of its own (decision 141). Answers `{ result }` (columns, rows as text, whether
 * more rows were left unread) or `{ failure: { code, message, position } }` when the database
 * refused or stopped it or it was cancelled or not allowed. Refused with 403
 * `data_access_disabled` unless viewing table data is on, and with 429 `sql_busy` while another
 * statement runs on the connection.
 *
 * This is the one route that takes SQL text, so: the body is JSON (the text never appears in a
 * URL), strict (no other key exists), and at most 256 KB; there is no GET; the response is
 * `no-store`; and neither the text nor a row is ever logged. The client going away cancels the
 * statement in the database.
 */
import { sqlRunRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024 + 1024;

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, sqlRunRequestSchema, MAX_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const outcome = await getServerContext().sql.run(id, parsed.data, request.signal);
    return jsonResponse(outcome);
  });
}
