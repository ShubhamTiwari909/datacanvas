/**
 * POST /api/connections/test
 *
 * Checks that the connection details work, WITHOUT remembering anything.
 * Backs the "Test connection" button. Responds `{ "ok": true }` or a standard
 * error whose `code` says what is wrong (authentication_failed, unreachable,
 * ssl_error, database_not_found, ...).
 *
 * Note: a static folder name such as `test` wins over the dynamic `[id]` folder
 * next to it, so this is never mistaken for a connection id.
 */
import { postgresConnectionInputSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleRoute(request, async () => {
    const parsed = await parseJsonBody(request, postgresConnectionInputSchema);
    if (!parsed.ok) return parsed.response;

    await getServerContext().connections.testConnection(parsed.data);
    return jsonResponse({ ok: true });
  });
}
