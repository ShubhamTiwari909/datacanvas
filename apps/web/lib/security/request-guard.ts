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
   * this reflects the flag. Nothing in the API can change it.
   */
  writesEnabled: boolean;
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
