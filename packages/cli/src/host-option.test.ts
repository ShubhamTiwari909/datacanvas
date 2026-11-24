import { describe, expect, it } from "vitest";
import { ALLOW_ANY_INTERFACE_ENV, resolveHost } from "./host-option.js";

describe("resolveHost", () => {
  it("listens on loopback by default and when asked to", () => {
    expect(resolveHost(undefined, {})).toEqual({ ok: true, host: "127.0.0.1" });
    expect(resolveHost("127.0.0.1", {})).toEqual({ ok: true, host: "127.0.0.1" });
    // Even with the permission set, nothing asked for means loopback.
    expect(resolveHost(undefined, { [ALLOW_ANY_INTERFACE_ENV]: "1" })).toEqual({
      ok: true,
      host: "127.0.0.1",
    });
  });

  it("refuses all interfaces unless the environment allows it, and says why", () => {
    for (const env of [{}, { [ALLOW_ANY_INTERFACE_ENV]: "" }, { [ALLOW_ANY_INTERFACE_ENV]: "0" }]) {
      const choice = resolveHost("0.0.0.0", env);
      expect(choice.ok).toBe(false);
      if (!choice.ok) {
        expect(choice.message).toMatch(/other computers on your network/);
        expect(choice.message).toContain(ALLOW_ANY_INTERFACE_ENV);
      }
    }
  });

  it("accepts all interfaces only when the variable is exactly 1 (not true, not yes)", () => {
    expect(resolveHost("0.0.0.0", { [ALLOW_ANY_INTERFACE_ENV]: "1" })).toEqual({
      ok: true,
      host: "0.0.0.0",
    });
    for (const other of ["true", "yes", "on", " 1"]) {
      expect(resolveHost("0.0.0.0", { [ALLOW_ANY_INTERFACE_ENV]: other }).ok).toBe(false);
    }
  });

  it("refuses any other value, even with the permission", () => {
    for (const value of ["localhost", "::", "192.168.1.5", "", "0.0.0.0 ", "::1"]) {
      expect(resolveHost(value, { [ALLOW_ANY_INTERFACE_ENV]: "1" }).ok, value).toBe(false);
    }
  });
});
