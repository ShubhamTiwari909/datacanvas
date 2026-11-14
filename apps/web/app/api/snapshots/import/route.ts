/**
 * POST /api/snapshots/import
 *
 * Body: the content of an exported `.snapshot.json` file. It is upgraded to the
 * current format, validated, and saved as a NEW snapshot (an import never
 * overwrites anything). Answers 201 with the summary.
 */
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import { jsonResponse } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A snapshot of thousands of tables is a few MB; the limit only stops abuse. */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export function POST(request: Request): Promise<Response> {
  return handleRoute(request, async () => {
    // Any JSON is accepted here: it is checked properly (and upgraded) by the service.
    const body = await parseJsonBody(request, z.unknown(), MAX_BODY_BYTES);
    if (!body.ok) return body.response;
    const snapshot = await getServerContext().snapshots.importFile(body.data);
    return jsonResponse({ snapshot }, 201);
  });
}
