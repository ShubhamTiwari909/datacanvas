/**
 * Route test for the statistics of a table (1.10.0, V3; decision 165), against a temporary data folder and a mock
 * adapter: figures and sizes, no value anywhere, no need for "Allow viewing table data" (they read no row), null for a
 * view, and the usual refusals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as createConnection } from "./connections/route";
import { GET as getStatistics } from "./connections/[id]/tables/[table]/statistics/route";

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

const ask = (id: string, table: string, schema = "public") =>
  getStatistics(
    new Request(`${BASE}/x?schema=${encodeURIComponent(schema)}`),
    params({ id, table }),
  );

describe("GET /connections/:id/tables/:table/statistics", () => {
  it("answers figures for each column and sizes, with no data access switched on", async () => {
    const id = await connect();
    const response = await ask(id, "users");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { statistics } = (await response.json()) as {
      statistics: {
        table: { name: string };
        tableBytes: number;
        columns: Array<{ column: string; hasStatistics: boolean; nullFraction: number | null }>;
      };
    };
    expect(statistics.table.name).toBe("users");
    expect(statistics.tableBytes).toBeGreaterThan(0);
    expect(statistics.columns.length).toBeGreaterThan(0);
    expect(statistics.columns.every((c) => c.hasStatistics)).toBe(true);
  });

  it("answers null for a name that is not a table (a view, or nothing)", async () => {
    const id = await connect();
    const response = await ask(id, "no_such_table");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ statistics: null });
  });

  it("refuses a table name that is not valid and a missing schema", async () => {
    const id = await connect();
    expect((await ask(id, "")).status).toBe(400);
    const noSchema = await getStatistics(new Request(`${BASE}/x`), params({ id, table: "users" }));
    expect(noSchema.status).toBe(400);
  });

  it("answers 404 for an unknown connection and never contains the password", async () => {
    const missing = await ask("missing", "users");
    expect(missing.status).toBe(404);
    const id = await connect();
    expect(await (await ask(id, "users")).text()).not.toContain("s3cret-pw");
  });
});
