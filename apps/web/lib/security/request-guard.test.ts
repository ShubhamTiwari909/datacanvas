/**
 * Tests for the local-server guard: Host, Origin, Sec-Fetch-Site and the
 * session token. These are the controls that stop DNS rebinding, CSRF and
 * other local programs, so each rule gets a positive and a negative case.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateRequest,
  isAllowedHost,
  isAllowedOrigin,
  readCookie,
  readSecurityConfig,
  sessionCookieName,
  tokensMatch,
  type RequestFacts,
  type SecurityConfig,
} from "./request-guard";

const TOKEN = "t".repeat(43);
const config: SecurityConfig = {
  port: 4747,
  token: TOKEN,
  tokenRequired: true,
  writesEnabled: false,
};

function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    method: "GET",
    pathname: "/api/connections",
    host: "127.0.0.1:4747",
    origin: null,
    secFetchSite: "same-origin",
    cookieToken: TOKEN,
    ...overrides,
  };
}

describe("isAllowedHost", () => {
  it("accepts 127.0.0.1 and localhost on the right port", () => {
    expect(isAllowedHost("127.0.0.1:4747", 4747)).toBe(true);
    expect(isAllowedHost("localhost:4747", 4747)).toBe(true);
    expect(isAllowedHost("LOCALHOST:4747", 4747)).toBe(true);
  });

  it.each([
    ["wrong port", "127.0.0.1:9999"],
    ["rebinding domain", "evil.example:4747"],
    ["look-alike suffix", "127.0.0.1.evil.example:4747"],
    ["look-alike prefix", "evil127.0.0.1:4747"],
    ["no port", "127.0.0.1"],
    ["userinfo", "user@127.0.0.1:4747"],
    ["IPv6", "[::1]:4747"],
    ["0.0.0.0", "0.0.0.0:4747"],
    ["empty", ""],
  ])("rejects %s", (_name, host) => {
    expect(isAllowedHost(host, 4747)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isAllowedHost(null, 4747)).toBe(false);
  });

  it("accepts any port, but still only our host names, when the port is unknown", () => {
    expect(isAllowedHost("127.0.0.1:1234", null)).toBe(true);
    expect(isAllowedHost("evil.example:1234", null)).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("accepts our own http origins only", () => {
    expect(isAllowedOrigin("http://127.0.0.1:4747", 4747)).toBe(true);
    expect(isAllowedOrigin("http://localhost:4747", 4747)).toBe(true);
    expect(isAllowedOrigin("https://127.0.0.1:4747", 4747)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:8080", 4747)).toBe(false);
    expect(isAllowedOrigin("http://evil.example", 4747)).toBe(false);
    expect(isAllowedOrigin("null", 4747)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:4747/path", 4747)).toBe(false);
  });
});

describe("tokensMatch", () => {
  it("compares exactly", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, TOKEN.slice(1))).toBe(false);
    expect(tokensMatch(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokensMatch(TOKEN, "x".repeat(TOKEN.length))).toBe(false);
    expect(tokensMatch(TOKEN, null)).toBe(false);
  });
});

describe("readCookie", () => {
  it("finds a cookie among several", () => {
    expect(readCookie("a=1; dc_session_4747=abc; b=2", "dc_session_4747")).toBe("abc");
    expect(readCookie("a=1", "dc_session_4747")).toBeNull();
    expect(readCookie(null, "x")).toBeNull();
  });

  it("names the cookie by port so two instances do not clash", () => {
    expect(sessionCookieName(4747)).toBe("dc_session_4747");
    expect(sessionCookieName(4748)).not.toBe(sessionCookieName(4747));
  });
});

describe("readSecurityConfig", () => {
  it("reads port and token", () => {
    expect(readSecurityConfig({ PORT: "4747", DATACANVAS_SESSION_TOKEN: "abc" })).toEqual({
      port: 4747,
      token: "abc",
      tokenRequired: true,
      writesEnabled: false,
    });
  });

  it("requires a token in production even when none was configured (fail closed)", () => {
    const cfg = readSecurityConfig({ NODE_ENV: "production", PORT: "4747" });
    expect(cfg).toEqual({ port: 4747, token: null, tokenRequired: true, writesEnabled: false });
  });

  it("enables writes only for the exact value the CLI sets", () => {
    const withToken = (value: string) =>
      readSecurityConfig({ DATACANVAS_ENABLE_WRITES: value, DATACANVAS_SESSION_TOKEN: "abc" });
    expect(withToken("1").writesEnabled).toBe(true);
    for (const value of ["true", "yes", "on", "0", "", " 1"]) {
      expect(withToken(value).writesEnabled).toBe(false);
    }
    expect(readSecurityConfig({}).writesEnabled).toBe(false);
  });

  it("never enables writes without a session token (a development server has none)", () => {
    expect(readSecurityConfig({ DATACANVAS_ENABLE_WRITES: "1" }).writesEnabled).toBe(false);
    expect(
      readSecurityConfig({ DATACANVAS_ENABLE_WRITES: "1", NODE_ENV: "development" }).writesEnabled,
    ).toBe(false);
  });

  it("does not require a token in development or tests when none is set", () => {
    expect(readSecurityConfig({ NODE_ENV: "development" }).tokenRequired).toBe(false);
    expect(readSecurityConfig({}).tokenRequired).toBe(false);
  });

  it("ignores an invalid port", () => {
    expect(readSecurityConfig({ PORT: "abc" }).port).toBeNull();
    expect(readSecurityConfig({ PORT: "70000" }).port).toBeNull();
  });
});

describe("evaluateRequest", () => {
  it("allows a normal same-origin request with the cookie", () => {
    expect(evaluateRequest(facts(), config)).toEqual({ ok: true });
  });

  it("refuses a foreign Host with 403", () => {
    const d = evaluateRequest(facts({ host: "evil.example:4747" }), config);
    expect(d).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });

  it("refuses cross-site and same-site (other port) browser requests to the API", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(evaluateRequest(facts({ secFetchSite: site }), config)).toMatchObject({
        ok: false,
        status: 403,
      });
    }
  });

  it("allows a typed URL or bookmark (Sec-Fetch-Site: none) and non-browser clients", () => {
    expect(evaluateRequest(facts({ secFetchSite: "none" }), config).ok).toBe(true);
    expect(evaluateRequest(facts({ secFetchSite: null }), config).ok).toBe(true);
  });

  it("refuses a state-changing request with a foreign Origin", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const d = evaluateRequest(facts({ method, origin: "http://evil.example" }), config);
      expect(d).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("allows a state-changing request from our own origin", () => {
    const d = evaluateRequest(facts({ method: "POST", origin: "http://127.0.0.1:4747" }), config);
    expect(d.ok).toBe(true);
  });

  it("refuses a missing or wrong cookie with 401", () => {
    expect(evaluateRequest(facts({ cookieToken: null }), config)).toMatchObject({
      ok: false,
      status: 401,
      code: "unauthorized",
    });
    expect(evaluateRequest(facts({ cookieToken: "wrong" }), config)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("lets /api/health through without a cookie, but still checks the Host", () => {
    const health = { pathname: "/api/health", cookieToken: null };
    expect(evaluateRequest(facts(health), config).ok).toBe(true);
    expect(evaluateRequest(facts({ ...health, host: "evil.example:4747" }), config).ok).toBe(false);
  });

  it("fails closed with 503 when a token is required but none is configured", () => {
    const d = evaluateRequest(facts(), {
      port: 4747,
      token: null,
      tokenRequired: true,
      writesEnabled: false,
    });
    expect(d).toMatchObject({ ok: false, status: 503 });
  });

  it("skips only the token check when no token is required", () => {
    const open: SecurityConfig = {
      port: null,
      token: null,
      tokenRequired: false,
      writesEnabled: false,
    };
    expect(evaluateRequest(facts({ cookieToken: null }), open).ok).toBe(true);
    expect(evaluateRequest(facts({ host: "evil.example:1" }), open).ok).toBe(false);
  });

  it("never echoes request data in the refusal message", () => {
    const d = evaluateRequest(facts({ host: "evil-marker.example:4747" }), config);
    expect(JSON.stringify(d)).not.toContain("evil-marker");
  });
});
