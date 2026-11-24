import { describe, expect, it } from "vitest";
import { buildCsp, makeNonce } from "./csp";

describe("makeNonce", () => {
  it("is 128 bits of base64, different every time", () => {
    const nonces = new Set(Array.from({ length: 200 }, () => makeNonce()));
    expect(nonces.size).toBe(200);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    }
  });
});

describe("buildCsp", () => {
  const policy = buildCsp("abc123==");
  const directive = (name: string) =>
    policy
      .split("; ")
      .find((d) => d.startsWith(`${name} `))
      ?.slice(name.length + 1)
      .split(" ");

  it("lets a script run only with the nonce, and never from inline text or eval", () => {
    expect(directive("script-src")).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'"]);
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
  });

  it("allows eval for the development server only", () => {
    expect(buildCsp("n", { dev: true })).toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(buildCsp("n", { dev: false })).not.toContain("unsafe-eval");
  });

  it("starts from nothing and opens only what the app uses", () => {
    expect(directive("default-src")).toEqual(["'none'"]);
    expect(directive("connect-src")).toEqual(["'self'"]);
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'none'"]);
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
    expect(directive("form-action")).toEqual(["'self'"]);
    expect(directive("worker-src")).toEqual(["'self'"]);
    expect(directive("font-src")).toEqual(["'self'"]);
    expect(directive("img-src")).toEqual(["'self'", "data:"]);
  });

  it("keeps inline styles (style attributes cannot carry a nonce) and says it plainly", () => {
    expect(directive("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("names no other site", () => {
    expect(policy).not.toMatch(/https?:|\*/);
  });
});
