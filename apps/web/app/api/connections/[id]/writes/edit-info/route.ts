/**
 * POST /api/connections/:id/writes/edit-info
 *
 * Body: `{ schema, table }`. What the row editor needs about one table:
 * whether its rows can be edited and by which key, its columns (type,
 * nullable, default, generated or identity, editable), its triggers,
 * row-level security and the foreign keys that point at it. Answers
 * `{ info }`. Catalog only, read-only, no rows; needs writes unlocked.
 */
import { editInfoRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, editInfoRequestSchema);
    if (!parsed.ok) return parsed.response;
    const info = await getServerContext().writes.editInfo(id, {
      schema: parsed.data.schema,
      name: parsed.data.table,
    });
    return jsonResponse({ info });
  });
}
