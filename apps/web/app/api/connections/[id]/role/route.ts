/**
 * GET /api/connections/:id/role
 *
 * What the connected database role can do (superuser, creating roles or
 * databases, bypassing row-level security, predefined write and server-file
 * roles, CREATE rights, how many tables it can write to) and the address the
 * server reports, with the warnings for each mode:
 * `{ role, warnings: { read: [...], write: [...] } }` (decision 126).
 * Catalog only, read-only: this route reads no table rows. A warning is
 * information, never a block.
 */
import { roleWarnings } from "@datacanvas/database-core";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const role = await getServerContext().connections.getRoleInfo(id);
    return jsonResponse({
      role,
      warnings: { read: roleWarnings(role, "read"), write: roleWarnings(role, "write") },
    });
  });
}
