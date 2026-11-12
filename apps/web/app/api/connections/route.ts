/**
 * /api/connections
 *
 *   GET   list the open connections (never includes passwords)
 *   POST  connect to a database and remember the connection -> 201 with its summary
 *
 * POST body: see `postgresConnectionInputSchema` in @datacanvas/shared-types.
 * SECURITY: do not log the request body or the parsed connection; both hold the password.
 */
import {
  postgresConnectionInputSchema,
  type ConnectionResponse,
  type ListConnectionsResponse,
} from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleRoute(async () => {
    const body: ListConnectionsResponse = {
      connections: getServerContext().connections.listConnections(),
    };
    return jsonResponse(body);
  });
}

export function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const parsed = await parseJsonBody(request, postgresConnectionInputSchema);
    if (!parsed.ok) return parsed.response;

    const connection = await getServerContext().connections.createConnection(parsed.data);
    const body: ConnectionResponse = { connection };
    return jsonResponse(body, 201);
  });
}
