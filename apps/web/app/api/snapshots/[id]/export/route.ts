/**
 * GET /api/snapshots/:id/export
 *
 * Downloads a snapshot as a `.snapshot.json` file.
 *
 * Reminder for users: the file lists table and column names, which can be
 * sensitive, and view and function definitions are copied as written, so they can contain
 * anything typed into them. It holds no rows (whether or not data viewing is on) and no connection credentials.
 */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import type { RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const { fileName, content } = await getServerContext().snapshots.exportFile(id);
    return new Response(`${JSON.stringify(content, null, 2)}\n`, {
      headers: {
        "Content-Type": "application/json",
        // `fileName` only contains letters, digits and . _ - space (see snapshotFileName),
        // so it cannot break out of this header.
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
