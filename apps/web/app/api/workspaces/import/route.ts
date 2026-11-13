/**
 * POST /api/workspaces/import[?profileId=...]
 *
 * Body: the content of an exported `.datacanvas.json` file. It is upgraded to
 * the current format, validated, and saved as a NEW workspace attached to the
 * given saved connection (an import never overwrites anything). Answers 201.
 */
import { workspaceListQuerySchema } from "@datacanvas/shared-types";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, parseQuery } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

export function POST(request: Request): Promise<Response> {
  return handleRoute(request, async () => {
    const query = parseQuery(request, workspaceListQuerySchema);
    if (!query.ok) return query.response;
    // Any JSON is accepted here: it is checked properly (and upgraded) by the service.
    const body = await parseJsonBody(request, z.unknown(), MAX_BODY_BYTES);
    if (!body.ok) return body.response;

    const workspace = await getServerContext().workspaces.importFile(
      body.data,
      query.data.profileId ?? null,
    );
    return jsonResponse({ workspace }, 201);
  });
}
