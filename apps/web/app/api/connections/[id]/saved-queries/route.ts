/** List saved query names or explicitly save a statement to the local library. */
import { MAX_SAVED_QUERY_BODY_BYTES, saveQueryRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse, type RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = RouteParams<{ id: string }>;

export function GET(request: Request, { params }: Params): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    return jsonResponse({ queries: await getServerContext().savedQueries.list(id) });
  });
}

export function POST(request: Request, { params }: Params): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const input = await parseJsonBody(request, saveQueryRequestSchema, MAX_SAVED_QUERY_BODY_BYTES);
    if (!input.ok) return input.response;
    return jsonResponse({ queries: await getServerContext().savedQueries.add(id, input.data) });
  });
}
