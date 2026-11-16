/**
 * GET /api/connections/:id/objects
 *
 * Views (with their definitions and what they read), types, sequences,
 * functions, triggers, extensions and row-level-security policies. Definitions
 * and settings from the catalogs only: this route reads no table rows and no
 * sequence values.
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const objects = await getServerContext().connections.getObjects(id);
    return jsonResponse({ objects });
  });
}
