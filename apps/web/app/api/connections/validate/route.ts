/**
 * POST /api/connections/validate
 *
 * Checks that PostgreSQL connection details are well formed, WITHOUT
 * connecting to any database. Returns a summary that never includes the
 * password. (Phase 6 adds the endpoints that actually connect.)
 *
 * Request body: see `postgresConnectionInputSchema` in @datacanvas/shared-types.
 *
 * SECURITY: do not log the request body or the parsed connection; both hold
 * the password.
 */
import {
  postgresConnectionInputSchema,
  resolvePostgresConnection,
  summarizePostgresConnection,
  type ValidateConnectionResponse,
} from "@datacanvas/shared-types";
import { parseJsonBody } from "@/lib/server/parse-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseJsonBody(request, postgresConnectionInputSchema);
  if (!parsed.ok) return parsed.response;

  const connection = resolvePostgresConnection(parsed.data);
  const body: ValidateConnectionResponse = { connection: summarizePostgresConnection(connection) };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
