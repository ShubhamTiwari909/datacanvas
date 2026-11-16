/**
 * POST /api/connections/:id/writes/preview
 *
 * Body: `{ change }`, one structured operation (a row change or a change of
 * structure; see `changeSchema`). There is no SQL in it: the schema is strict
 * at every level, so a `sql`, `where`, `expression` or any unknown key is
 * refused. Nothing is changed. The adapter checks the change against the
 * catalog and plans the exact statements, which stay on the server under a
 * single-use id for five minutes.
 *
 * Answers `{ preview: { previewId, statement, effect, warnings, destructive,
 * category, expiresAt } }`. `statement` shows values as `$1`, `$2`, ...: the
 * values themselves are never sent back, logged or echoed in an error.
 * Needs all four switches (see `GET .../writes`).
 */
import { previewChangeRequestSchema, WRITE_MAX_BODY_BYTES } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, previewChangeRequestSchema, WRITE_MAX_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const preview = await getServerContext().writes.preview(id, parsed.data.change);
    return jsonResponse({ preview });
  });
}
