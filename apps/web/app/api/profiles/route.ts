/** GET /api/profiles: the saved connection profiles (never any password). */
import { getServerContext } from "@/lib/server/context";
import { handleRoute } from "@/lib/server/error-response";
import { jsonResponse } from "@/lib/server/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleRoute(async () =>
    jsonResponse({ profiles: await getServerContext().profiles.list() }),
  );
}
