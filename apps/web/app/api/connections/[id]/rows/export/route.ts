/**
 * POST /api/connections/:id/rows/export
 *
 * Body: `{ schema, table, format: "csv" | "tsv" | "json" | "ndjson", delimiter?, header?, nullText?, meta?,
 * revealColumns?, sort?, filters? }`. The rows of a table as a FILE, as filtered and sorted on screen,
 * streamed a batch at a time (decision 158). Up to 100,000 rows and 64 MB, then a line that says the file was
 * cut. Columns whose names look sensitive are left out unless revealed, and the file says which. A value a
 * spreadsheet would run as a formula gets a leading apostrophe.
 *
 * Refused (403 `data_access_disabled`) unless viewing table data was switched on for this connection, like a
 * page of rows. One export at a time per connection (429 `export_busy`). The body is JSON (names and values
 * never appear in a URL or a log), the schema is strict, the response is `no-store`, a client that goes away
 * ends the read, and no value is ever logged, kept or put in an error. The answer is the file, not JSON: an
 * error that is known before the first byte is the usual JSON error.
 */
import { exportRequestSchema } from "@datacanvas/shared-types";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import type { RouteParams } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request, { params }: RouteParams<{ id: string }>): Promise<Response> {
  return handleRoute(request, async () => {
    const { id } = await params;
    const parsed = await parseJsonBody(request, exportRequestSchema);
    if (!parsed.ok) return parsed.response;
    const { stream, contentType } = await getServerContext().connections.exportRows(
      id,
      parsed.data,
      request.signal,
    );
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
