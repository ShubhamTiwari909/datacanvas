/**
 * Route test for the index usage counters, against a temporary data folder and
 * a mock adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as createConnection } from "./connections/route";
import { GET as getIndexUsage } from "./connections/[id]/index-usage/route";

const BASE = "http://127.0.0.1:4747/api";
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let context: TestContext;
beforeEach(() => {
  context = createTestContext();
  setServerContextForTests(context);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setServerContextForTests(undefined);
  vi.restoreAllMocks();
});

async function connect(): Promise<string> {
  const response = await createConnection(
    new Request(`${BASE}/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fieldsInput()),
    }),
  );
  return ((await response.json()) as { connection: { id: string } }).connection.id;
}

describe("GET /connections/:id/index-usage", () => {
  it("returns the counters, with when they were reset and the standby flag", async () => {
    const id = await connect();
    const response = await getIndexUsage(new Request(`${BASE}/x`), params({ id }));
    const body = (await response.json()) as {
      usage: { statsReset: string | null; inRecovery: boolean; indexes: Array<{ scans: number }> };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.usage.inRecovery).toBe(false);
    expect(body.usage.statsReset).toBe("2026-10-01T00:00:00.000Z");
    expect(body.usage.indexes.length).toBeGreaterThan(0);
    expect(body.usage.indexes.some((i) => i.scans === 0)).toBe(true);
  });

  it("answers 404 for an unknown connection", async () => {
    const response = await getIndexUsage(new Request(`${BASE}/x`), params({ id: "missing" }));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "connection_not_found",
    );
  });

  it("never contains the password", async () => {
    const id = await connect();
    const response = await getIndexUsage(new Request(`${BASE}/x`), params({ id }));
    expect(await response.text()).not.toContain("s3cret-pw");
  });
});
