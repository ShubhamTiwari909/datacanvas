import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiRequest } from "./api-client";

const schema = z.object({ ok: z.boolean() });

afterEach(() => vi.unstubAllGlobals());

describe("apiRequest and an abort", () => {
  it("answers `aborted` when the signal aborts while the request is out", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const pending = apiRequest("/api/x", schema, { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({
      ok: false,
      error: { code: "aborted", message: "The request was cancelled.", issues: [] },
    });
  });

  it("answers `aborted`, not an unreadable response, when it aborts while the body is read", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: () => {
        controller.abort();
        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      },
    }));
    const result = await apiRequest("/api/x", schema, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
  });

  it("still calls an unreadable body unreadable when nothing was aborted", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    }));
    const result = await apiRequest("/api/x", schema);
    expect(result).toMatchObject({ ok: false, error: { code: "bad_response" } });
  });

  it("passes the signal to fetch, and a normal answer through", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen = init.signal;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    expect(await apiRequest("/api/x", schema, { signal: controller.signal })).toEqual({
      ok: true,
      data: { ok: true },
    });
    expect(seen).toBe(controller.signal);
  });
});
