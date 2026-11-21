/**
 * Route tests for the pre-flight of a migration (`POST /connections/:id/rows/preflight`): the same opt-in as a page of rows,
 * a strict body in which a check is names and never SQL, and no value in any error or log. (The queries are tested in the adapter's tests.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as createConnection } from "./connections/route";
import { POST as preflight } from "./connections/[id]/rows/preflight/route";

const BASE = "http://127.0.0.1:4747/api";
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(response: Promise<Response> | Response) {
  const r = await response;
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : undefined) as Json, text };
}
const json = (url: string, method: string, body: unknown): Request =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

let context: TestContext;
let logged: unknown[][];
beforeEach(() => {
  context = createTestContext();
  setServerContextForTests(context);
  logged = [];
  for (const method of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
});
afterEach(() => {
  setServerContextForTests(undefined);
  vi.restoreAllMocks();
});

async function connect(extra: Record<string, unknown> = {}): Promise<string> {
  const { body } = await call(
    createConnection(json(`${BASE}/connections`, "POST", fieldsInput(extra))),
  );
  return body.connection.id;
}
const check = (id: string, body: unknown) =>
  call(preflight(json(`${BASE}/connections/x/rows/preflight`, "POST", body), params({ id })));
const ask = { checks: [{ kind: "nulls", schema: "public", table: "users", column: "email" }] };

describe("POST /connections/:id/rows/preflight", () => {
  it("is refused (403) while data access is off, before anything is counted", async () => {
    const id = await connect();
    const result = await check(id, ask);
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("data_access_disabled");
  });

  it("answers 404 for an unknown connection", async () => {
    expect((await check("unknown-connection-id-0000", ask)).status).toBe(404);
  });

  it("answers once data access is on: here the sample database has nothing to count, and says so", async () => {
    const id = await connect({ dataAccess: true });
    const result = await check(id, ask);
    expect(result.status).toBe(200);
    expect(result.body.results).toEqual([{ status: "missing", count: 0 }]);
  });

  it.each([
    ["no checks", { checks: [] }],
    ["more than 50 checks", { checks: Array(51).fill(ask.checks[0]) }],
    ["a kind that does not exist", { checks: [{ kind: "sql", schema: "public", table: "t" }] }],
    ["a where clause in a check", { checks: [{ ...ask.checks[0], where: "1=1" }] }],
    ["a sql field in a check", { checks: [{ ...ask.checks[0], sql: "select 1" }] }],
    ["an extra field in the request", { ...ask, sql: "select 1" }],
    [
      "no columns for a key",
      { checks: [{ kind: "duplicates", schema: "a", table: "b", columns: [] }] },
    ],
    [
      "a foreign key without its target",
      { checks: [{ kind: "orphans", schema: "a", table: "b", columns: ["c"] }] },
    ],
    ["a column that is not text", { checks: [{ ...ask.checks[0], column: 5 }] }],
  ])("refuses %s with 400 validation_error", async (_name, body) => {
    const id = await connect({ dataAccess: true });
    const result = await check(id, body);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("validation_error");
  });

  it("is never cached, and an error holds no name or value of the request", async () => {
    const id = await connect({ dataAccess: true });
    const secret = "hunter2-SECRET-NAME";
    const r = await preflight(
      json(`${BASE}/connections/x/rows/preflight`, "POST", {
        checks: [{ kind: "nulls", schema: "public", table: secret, column: "c" }],
      }),
      params({ id }),
    );
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).not.toContain(secret);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
});
