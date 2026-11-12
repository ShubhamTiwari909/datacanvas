/**
 * Catch-all for unknown `/api/*` URLs.
 *
 * Without this, Next.js answers an unknown API URL with its HTML 404 page,
 * which a client that expects JSON cannot parse. This returns the standard
 * JSON error instead. Next.js always prefers the more specific route, so
 * `/api/health` still reaches its own handler.
 */
import { errorResponse } from "@/lib/server/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound(): Response {
  return errorResponse("not_found", "This API endpoint does not exist.", 404);
}

// One handler for every method, so a wrong method on a wrong URL is also a clean 404.
export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
