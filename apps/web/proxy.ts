/**
 * The front door of the local server (Next.js 16 calls this file "proxy"; it
 * used to be called "middleware"). It runs BEFORE any page or API route.
 *
 * It does two jobs, both described in `lib/security/request-guard.ts`:
 *
 *  1. Refuse requests with a foreign Host header, a foreign Origin, or no
 *     valid session cookie (DNS rebinding, CSRF, other local programs).
 *  2. Exchange the one-time `?token=` in the first URL for an HttpOnly cookie,
 *     then redirect to the same URL without the token, so the secret does not
 *     stay in the address bar, the history or a Referer header.
 *
 * Every route handler repeats the same checks (`handleRoute`), so a mistake in
 * this file's matcher, or a future Next.js change, cannot silently open the API.
 */
import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/server/api-response";
import { buildCsp, makeNonce } from "@/lib/security/csp";
import {
  TOKEN_QUERY_PARAM,
  evaluateMcpRequest,
  evaluateRequest,
  mcpFactsFromRequest,
  isAllowedHost,
  readSecurityConfig,
  sessionCookieName,
  tokensMatch,
  type RequestFacts,
} from "@/lib/security/request-guard";

export function proxy(request: NextRequest): Response {
  const security = readSecurityConfig();
  const { pathname, searchParams } = request.nextUrl;
  const host = request.headers.get("host");

  // First visit: exchange the URL token for the cookie. The Host check comes
  // first so a rebinding page cannot use this path to probe for the token.
  const urlToken = searchParams.get(TOKEN_QUERY_PARAM);
  if (
    urlToken !== null &&
    security.token !== null &&
    request.method === "GET" &&
    !pathname.startsWith("/api/") &&
    isAllowedHost(host, security.port) &&
    tokensMatch(security.token, urlToken)
  ) {
    const clean = request.nextUrl.clone();
    clean.searchParams.delete(TOKEN_QUERY_PARAM);
    const response = NextResponse.redirect(clean);
    response.cookies.set(sessionCookieName(security.port), security.token, {
      httpOnly: true, // page scripts (and so any injected script) cannot read it
      sameSite: "strict", // never sent with requests started by another site
      path: "/",
      // No Secure flag: the app is served over plain http on loopback, where
      // browsers would refuse to store a Secure cookie on some platforms.
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  // `/mcp` is for programs, with a token of its own and no cookie: its own guard (decision 169), and none of the page's.
  if (pathname === "/mcp") {
    const mcp = evaluateMcpRequest(mcpFactsFromRequest(request), security);
    if (mcp.ok) return NextResponse.next();
    return new Response(JSON.stringify({ error: { message: mcp.message } }), {
      status: mcp.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const facts: RequestFacts = {
    method: request.method,
    pathname,
    host,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    cookieToken: request.cookies.get(sessionCookieName(security.port))?.value ?? null,
  };
  const decision = evaluateRequest(facts, security);
  if (decision.ok) {
    // An API answer is JSON: no page, no script, nothing for a policy to govern.
    if (pathname.startsWith("/api/")) return NextResponse.next();
    // A page: a policy with a nonce made for this request. The request carries it too, because the framework reads the
    // nonce from the policy of the request to put it on its own scripts, and the layout reads `x-nonce` for ours.
    const nonce = makeNonce();
    const policy = buildCsp(nonce, { dev: process.env.NODE_ENV !== "production" });
    const headers = new Headers(request.headers);
    headers.set("Content-Security-Policy", policy);
    headers.set("x-nonce", nonce);
    const response = NextResponse.next({ request: { headers } });
    response.headers.set("Content-Security-Policy", policy);
    return response;
  }

  if (pathname.startsWith("/api/")) {
    return errorResponse(decision.code, decision.message, decision.status);
  }
  return new Response(`${decision.message}\n`, {
    status: decision.status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export const config = {
  // Everything except Next's static files, which hold no data and are public
  // code anyway. (Their Host header is not checked, but they cannot be abused:
  // they carry no secrets and no state.)
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
