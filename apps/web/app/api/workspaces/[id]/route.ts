/**
 * /api/workspaces/:id
 *
 *   GET     the full workspace
 *   PUT     create or update it (body: name, profileId, connectionHint, canvas)
 *   DELETE  delete it
 *
 * The client chooses the id (it is part of the URL); the server owns the
 * timestamps. A workspace holds a canvas LAYOUT only: no credentials, no
 * database structure.
 */
import { workspaceIdSchema, workspaceInputSchema } from "@datacanvas/shared-types";
import { errorResponse } from "@/lib/server/api-response";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A layout of a few hundred tables is far below this; the limit only stops abuse. */
const MAX_BODY_BYTES = 1024 * 1024;

export function GET(_request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(async () => {
    const { id } = await params;
    return jsonResponse({ workspace: await getServerContext().workspaces.get(id) });
  });
}

export function PUT(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(async () => {
    const { id } = await params;
    // Validate the id before anything else: it becomes part of a file name.
    if (!workspaceIdSchema.safeParse(id).success) {
      return errorResponse("validation_error", "The workspace id is not valid.", 400);
    }
    const parsed = await parseJsonBody(request, workspaceInputSchema, MAX_BODY_BYTES);
    if (!parsed.ok) return parsed.response;

    return jsonResponse({ workspace: await getServerContext().workspaces.save(id, parsed.data) });
  });
}

export function DELETE(
  _request: Request,
  { params }: RouteParams<{ id: string }>,
): Promise<Response> {
  return handleRoute(async () => {
    const { id } = await params;
    await getServerContext().workspaces.remove(id);
    return jsonResponse({ ok: true });
  });
}
