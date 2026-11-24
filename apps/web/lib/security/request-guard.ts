/**
 * Local-server protection: the rules that decide whether a request may reach
 * DataCanvas at all. Pure functions, no Next.js imports, so the SAME code runs
 * in `proxy.ts` (first line of defence) and in every route handler (second
 * line, "defence in depth") and is easy to unit test.
 *
 * Threats this answers (see docs/threat-model.md):
 *
 *  - DNS rebinding: a malicious site makes its own domain resolve to
 *    127.0.0.1 so the browser treats our API as "same origin" with it. The
 *    tell-tale is the Host header: it carries the attacker's domain. We accept
 *    only `127.0.0.1:<port>` and `localhost:<port>`.
 *  - Cross-site request forgery (CSRF): another website makes the browser send
 *    a state-changing request to 127.0.0.1. Browsers attach an `Origin` header
 *    to such requests; it must be one of our own origins. `Sec-Fetch-Site`
 *    (set by the browser, not by page scripts) must be same-origin.
 *  - Other local programs and cross-port pages: a per-run secret token, handed
 *    to the browser once and then kept in an HttpOnly cookie.
 *
 * What it does NOT do: it cannot stop a program running as the same user from
 * reading the token out of the process list or the CLI output. That attacker
 * can already read the user's files; see the threat model.
 */
import { timingSafeEqual } from "node:crypto";

/** Name of the environment variable through which the CLI hands the token to the server. */
export const SESSION_TOKEN_ENV = "DATACANVAS_SESSION_TOKEN";

/** The cookie holds the token. The port is part of the name: cookies are shared across ports. */
export function sessionCookieName(port: number | null): string {
  return port === null ? "dc_session" : `dc_session_${port}`;
}

/** Query parameter that carries the token on the very first page load only. */
export const TOKEN_QUERY_PARAM = "token";

/**
 * The variable through which the CLI gives the server the token of `/mcp` (`docs/mcp-server-plan.md`, section 5.2;
 * decision 169). It is a DIFFERENT secret from the session token: it is accepted on that one route and nowhere else.
 */
export const MCP_TOKEN_ENV = "DATACANVAS_MCP_TOKEN";

export interface SecurityConfig {
  /** The port the server listens on, or null when unknown (development only). */
  port: number | null;
  /** The expected session token, or null when none was configured. */
  token: string | null;
  /**
   * True when requests MUST carry the token. Production always requires it:
   * a missing token then means "misconfigured", and the safe answer to that is
   * to refuse everything (fail closed), never to let everything in.
   */
  tokenRequired: boolean;
  /**
   * DataCanvas was started with `--enable-writes` (decision 125). Only the CLI
   * sets the variable, and it removes any value inherited from the shell, so
   * this reflects the flag. It is also off when there is no session token (a development
   * server): see `readSecurityConfig`. Nothing in the API can change it.
   */
  writesEnabled: boolean;
  /** The token `/mcp` requires, or null when none was given (then `/mcp` does not exist). Never the session token. */
  mcpToken: string | null;
}

/** Name of the environment variable through which the CLI says writes are enabled (exactly "1"). */
export const ENABLE_WRITES_ENV = "DATACANVAS_ENABLE_WRITES";

/** Read the configuration from environment variables (the CLI sets them). */
export function readSecurityConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecurityConfig {
  const rawPort = Number(env.PORT);
  const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : null;
  const token = env[SESSION_TOKEN_ENV] ? env[SESSION_TOKEN_ENV] : null;
  return {
    port,
    token,
    tokenRequired: token !== null || env.NODE_ENV === "production",
    // Writes need the session token as well: without one only the Host check would stand in
    // front of them (a development server has no token), so they stay off.
    writesEnabled: env[ENABLE_WRITES_ENV] === "1" && token !== null,
    // The same value as the session token would give the browser's credential the power of the program's: refused.
    mcpToken: env[MCP_TOKEN_ENV] && env[MCP_TOKEN_ENV] !== token ? env[MCP_TOKEN_ENV] : null,
  };
}

/** What the guard needs to know about a request. */
export interface RequestFacts {
  method: string;
  /** URL path, e.g. "/api/connections". */
  pathname: string;
  /** The Host header (or null when absent). */
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  /** The value of the session cookie, if the browser sent one. */
  cookieToken: string | null;
}

export type GuardDecision =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; code: "unauthorized" | "forbidden"; message: string };

const HOST_NAMES = ["127.0.0.1", "localhost"] as const;
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Is this Host header one of ours?
 * Exactly `127.0.0.1:<port>` or `localhost:<port>` (case-insensitive host name).
 * When the port is unknown (development), any numeric port is accepted, but the
 * host NAME is still checked, which is what defeats DNS rebinding.
 */
export function isAllowedHost(host: string | null, port: number | null): boolean {
  if (host === null) return false;
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(host);
  if (!match) return false; // no port, IPv6 forms, userinfo, anything odd
  const [, name = "", portText = ""] = match;
  if (!(HOST_NAMES as readonly string[]).includes(name.toLowerCase())) return false;
  return port === null ? true : Number(portText) === port;
}

/** Is this Origin header one of ours? `http://127.0.0.1:<port>` or `http://localhost:<port>`. */
export function isAllowedOrigin(origin: string, port: number | null): boolean {
  if (!origin.startsWith("http://")) return false;
  return isAllowedHost(origin.slice("http://".length), port);
}

/** Constant-time string comparison, so response timing cannot reveal how much of a guess was right. */
export function tokensMatch(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pull one cookie's value out of a Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** The paths that need no token. Health only says "ok"; the CLI polls it before it has a cookie. */
const TOKEN_FREE_PATHS = new Set(["/api/health"]);

const forbidden = (message: string): GuardDecision => ({
  ok: false,
  status: 403,
  code: "forbidden",
  message,
});

/**
 * Decide whether a request may proceed.
 *
 * Order matters: the cheap, attacker-independent checks (Host, then browser
 * metadata) run before the token check, and every refusal uses a fixed
 * message that never echoes the request.
 */
export function evaluateRequest(facts: RequestFacts, config: SecurityConfig): GuardDecision {
  // 1. Host header: blocks DNS rebinding.
  if (!isAllowedHost(facts.host, config.port)) {
    return forbidden("This request was refused because of its Host header.");
  }

  // 2. Browser metadata. Browsers set these; page scripts cannot forge them.
  //    A page on another port of 127.0.0.1 is "same-site" but not same-origin,
  //    so only "same-origin" (our own pages) and "none" (typed URL, bookmark) pass.
  const isApi = facts.pathname.startsWith("/api/");
  if (isApi && facts.secFetchSite !== null) {
    if (facts.secFetchSite !== "same-origin" && facts.secFetchSite !== "none") {
      return forbidden("Requests from other web pages are not allowed.");
    }
  }
  // 3. Origin: every state-changing request from a browser carries one. A
  //    missing Origin means a non-browser client; the token check below is what
  //    controls those.
  if (STATE_CHANGING.has(facts.method.toUpperCase()) && facts.origin !== null) {
    if (!isAllowedOrigin(facts.origin, config.port)) {
      return forbidden("Requests from other web pages are not allowed.");
    }
  }

  // 4. Session token.
  if (config.tokenRequired && !TOKEN_FREE_PATHS.has(facts.pathname)) {
    if (config.token === null) {
      // Production without a token: refuse, loudly, rather than run open.
      return {
        ok: false,
        status: 503,
        code: "forbidden",
        message:
          "The server is not configured securely. Start DataCanvas with the datacanvas command.",
      };
    }
    if (!tokensMatch(config.token, facts.cookieToken)) {
      return {
        ok: false,
        status: 401,
        code: "unauthorized",
        message: "Open DataCanvas with the link printed by the datacanvas command.",
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------- /mcp ---

/** What the guard of `/mcp` needs to know: a program's request, not a browser's. */
export interface McpRequestFacts {
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  /** The `Authorization` header. */
  authorization: string | null;
}

export type McpGuardDecision =
  { ok: true } | { ok: false; status: 401 | 403 | 404; message: string };

/** The bearer token of an `Authorization` header, or null. */
export function readBearer(header: string | null): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(header ?? "");
  return match ? (match[1] ?? null) : null;
}

/**
 * The guard of `/mcp` (decision 169). Its callers are programs (a stdio bridge, an MCP client), not browsers:
 *  1. no token configured: the route does not exist (404), so nothing answers on it by accident;
 *  2. the Host check, as everywhere (DNS rebinding);
 *  3. a request with an `Origin` header, or a `Sec-Fetch-Site` header, is from a BROWSER and is refused (403): a web page
 *     must not be able to call this even if it learned the token (the specification asks a local server to do this). (Not
 *     `Sec-Fetch-Mode`: Node's own `fetch`, which the bridge and the official client use, sends `cors` there.)
 *  4. the bearer token of `/mcp`, compared in constant time. The session token is a different secret and is refused here,
 *     and this token is refused on every other route (the cookie guard never reads an `Authorization` header).
 * Every refusal is a fixed sentence that repeats nothing of the request.
 */
export function evaluateMcpRequest(
  facts: McpRequestFacts,
  config: SecurityConfig,
): McpGuardDecision {
  if (config.mcpToken === null) return { ok: false, status: 404, message: "Not found." };
  if (!isAllowedHost(facts.host, config.port)) {
    return {
      ok: false,
      status: 403,
      message: "This request was refused because of its Host header.",
    };
  }
  if (facts.origin !== null || facts.secFetchSite !== null) {
    return { ok: false, status: 403, message: "Requests from web pages are not allowed here." };
  }
  if (!tokensMatch(config.mcpToken, readBearer(facts.authorization))) {
    return { ok: false, status: 401, message: "A valid token is required." };
  }
  return { ok: true };
}

export function mcpFactsFromRequest(request: Request): McpRequestFacts {
  const url = new URL(request.url);
  return {
    host: request.headers.get("host") ?? url.host,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    authorization: request.headers.get("authorization"),
  };
}

/** Collect the facts about a standard `Request` (used by route handlers). */
export function factsFromRequest(request: Request, config: SecurityConfig): RequestFacts {
  const url = new URL(request.url);
  return {
    method: request.method,
    pathname: url.pathname,
    // In-process calls (unit tests) carry no Host header; fall back to the URL's.
    host: request.headers.get("host") ?? url.host,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    cookieToken: readCookie(request.headers.get("cookie"), sessionCookieName(config.port)),
  };
}

/**
 * Route-handler guard. Returns `null` when the request may proceed, or a
 * ready-made JSON error response. Imported lazily by `handleRoute`.
 */
export function guardRequest(
  request: Request,
  respond: (code: "unauthorized" | "forbidden", message: string, status: number) => Response,
  config: SecurityConfig = readSecurityConfig(),
): Response | null {
  const decision = evaluateRequest(factsFromRequest(request, config), config);
  return decision.ok ? null : respond(decision.code, decision.message, decision.status);
}
