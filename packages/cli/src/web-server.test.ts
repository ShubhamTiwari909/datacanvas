/** Tests for the security-relevant parts of how the CLI starts the server. */
import { describe, expect, it } from "vitest";
import { buildServerEnv, generateSessionToken } from "./web-server.js";

describe("generateSessionToken", () => {
  it("makes long, URL-safe, never-repeating tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes in base64url
  });
});

describe("buildServerEnv", () => {
  const env = buildServerEnv(4747, "tok", { HOSTNAME: "0.0.0.0", PATH: "/bin" });

  it("binds to loopback only, whatever HOSTNAME was before", () => {
    expect(env.HOSTNAME).toBe("127.0.0.1");
  });

  it("passes the port and the session token", () => {
    expect(env.PORT).toBe("4747");
    expect(env.DATACANVAS_SESSION_TOKEN).toBe("tok");
  });

  it("runs in production mode with telemetry off", () => {
    expect(env.NODE_ENV).toBe("production");
    expect(env.NEXT_TELEMETRY_DISABLED).toBe("1");
  });

  it("keeps the rest of the environment", () => {
    expect(env.PATH).toBe("/bin");
  });
});
