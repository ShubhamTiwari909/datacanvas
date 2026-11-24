/**
 * POST /mcp: the Model Context Protocol, read only (`docs/mcp-server-plan.md`; decision 169).
 *
 * Its callers are PROGRAMS (the stdio bridge `datacanvas mcp`, an MCP client), not browsers, so it has a guard and a token
 * of its own (`evaluateMcpRequest`): not the cookie of the app. The guard runs in the front door (`proxy.ts`) and again here.
 * Stateless: each request is one JSON-RPC message (or a batch) and each answer one JSON body; there is no session and no
 * stream, so `GET` is "method not allowed", as the specification allows a server with nothing to push.
 *
 * Nothing answers while no connection is shared (404). The body is JSON, at most 256 KB; nothing of it is logged.
 */
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { errorResponse } from "@/lib/server/api-response";
import { parseJsonBody } from "@/lib/server/parse-request";
import {
  evaluateMcpRequest,
  mcpFactsFromRequest,
  readSecurityConfig,
} from "@/lib/security/request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The largest body of a request: a tool call is a few hundred bytes, a statement at most 200,000 characters. */
export const MCP_MAX_BODY_BYTES = 256 * 1024;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function POST(request: Request): Promise<Response> {
  const decision = evaluateMcpRequest(mcpFactsFromRequest(request), readSecurityConfig());
  if (!decision.ok) {
    return new Response(JSON.stringify({ error: { message: decision.message } }), {
      status: decision.status,
      headers: { ...HEADERS, "Content-Type": "application/json" },
    });
  }
  const mcp = getServerContext().mcp;
  // While nothing is shared the route does not exist, whatever the body is: it is not even read.
  if (!mcp.anyShared()) {
    return new Response(JSON.stringify({ error: { message: "Not found." } }), {
      status: 404,
      headers: { ...HEADERS, "Content-Type": "application/json" },
    });
  }
  const parsed = await parseJsonBody(request, z.unknown(), MCP_MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const result = await mcp.handle(parsed.data, request.signal);
  if (result.status === 404) {
    return new Response(JSON.stringify({ error: { message: "Not found." } }), {
      status: 404,
      headers: { ...HEADERS, "Content-Type": "application/json" },
    });
  }
  if (result.body === null) return new Response(null, { status: result.status, headers: HEADERS });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...HEADERS, "Content-Type": "application/json" },
  });
}

/** There is no stream to open and no session to end. */
export function GET(): Response {
  return errorResponse("forbidden", "Method not allowed.", 405);
}

export function DELETE(): Response {
  return errorResponse("forbidden", "Method not allowed.", 405);
}
