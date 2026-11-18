import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "@/lib/api-client";

vi.mock("@/features/explorer/api", () => ({
  getSchemas: vi.fn(),
  getTables: vi.fn(),
  getTableDetails: vi.fn(),
}));

const { LOOKUP_TTL_MS, clearLookups, shared } = await import("./fk-lookups");

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (): ApiResult<never> => ({
  ok: false,
  error: { code: "unreachable", message: "No answer.", issues: [] },
});

beforeEach(() => clearLookups());

describe("shared lookups", () => {
  it("many rows asking at once cause one request", async () => {
    const load = vi.fn(async () => ok(["public"]));
    const answers = await Promise.all([1, 2, 3, 4].map(() => shared("k", load)));
    expect(load).toHaveBeenCalledTimes(1);
    expect(answers.every((a) => a.ok)).toBe(true);
  });

  it("keeps the answer for a short time, then asks again", async () => {
    let time = 1000;
    const load = vi.fn(async () => ok(1));
    await shared("k", load, () => time);
    time += LOOKUP_TTL_MS - 1;
    await shared("k", load, () => time);
    expect(load).toHaveBeenCalledTimes(1);
    time += 2;
    await shared("k", load, () => time);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failure", async () => {
    const load = vi.fn<() => Promise<ApiResult<number>>>().mockResolvedValueOnce(fail());
    load.mockResolvedValueOnce(ok(2));
    expect((await shared("k", load)).ok).toBe(false);
    expect(await shared("k", load)).toEqual(ok(2));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("different keys (for example another structure version) are separate", async () => {
    const load = vi.fn(async () => ok(1));
    await shared(JSON.stringify(["c1", 0, "schemas"]), load);
    await shared(JSON.stringify(["c1", 1, "schemas"]), load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
