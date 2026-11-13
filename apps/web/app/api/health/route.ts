/**
 * GET /api/health
 *
 * Tells the UI (and the CLI launcher) that the local server is up. It touches
 * no database and returns no sensitive information.
 *
 * Route handler anatomy: exporting a function named after an HTTP method
 * (`GET`, `POST`, ...) from a `route.ts` file makes Next.js call it for that
 * method on this URL. It receives a Request and returns a Response.
 */
import { APP_NAME, type HealthResponse } from "@datacanvas/shared-types";
import { guardRequest } from "@/lib/security/request-guard";
import { errorResponse } from "@/lib/server/api-response";

// Run on the Node.js runtime (not Edge). Every database route needs Node APIs
// such as TCP sockets, so all handlers declare this explicitly.
export const runtime = "nodejs";

// Never prerender or cache this response at build time; it must be computed on
// each request, otherwise a stale "ok" could be served forever.
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  // Needs no session token (the CLI polls it before the browser has a cookie),
  // but the Host/Origin rules still apply.
  const refused = guardRequest(request, errorResponse);
  if (refused) return refused;
  const body: HealthResponse = { status: "ok", application: APP_NAME };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
