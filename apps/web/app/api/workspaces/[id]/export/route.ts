/**
 * GET /api/workspaces/:id/export
 *
 * Downloads a workspace as a `.datacanvas.json` file. The machine-specific
 * connection link is removed; the file holds the layout only.
 *
 * Reminder for users: the file lists table names, which can be sensitive.
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import type { RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const { fileName, content } = await getServerContext().workspaces.exportFile(id);
    return new Response(`${JSON.stringify(content, null, 2)}\n`, {
      headers: {
        "Content-Type": "application/json",
        // `fileName` is restricted to printable ASCII without quotes (see exportFileName),
        // so it cannot break out of this header.
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
