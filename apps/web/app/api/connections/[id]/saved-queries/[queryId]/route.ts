/** Open, update, or remove an individual saved query in the connection's library. */
import { editSavedQueryRequestSchema, MAX_SAVED_QUERY_BODY_BYTES } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = RouteParams<{ id: string; queryId: string }>;

export function GET(request: Request, { params }: Params): Promise<Response> {
  return handleRoute(request, async () => {
    const { id, queryId } = await params;
    return jsonResponse(await getServerContext().savedQueries.get(id, queryId));
  });
}

export function PUT(request: Request, { params }: Params): Promise<Response> {
  return handleRoute(request, async () => {
    const { id, queryId } = await params;
    const input = await parseJsonBody(
      request,
      editSavedQueryRequestSchema,
      MAX_SAVED_QUERY_BODY_BYTES,
    );
    if (!input.ok) return input.response;
    return jsonResponse({
      queries: await getServerContext().savedQueries.edit(id, queryId, input.data),
    });
  });
}

export function DELETE(request: Request, { params }: Params): Promise<Response> {
  return handleRoute(request, async () => {
    const { id, queryId } = await params;
    return jsonResponse({ queries: await getServerContext().savedQueries.remove(id, queryId) });
  });
}
