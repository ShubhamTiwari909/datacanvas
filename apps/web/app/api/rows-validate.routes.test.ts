/**
 * Route tests for validation (`POST /connections/:id/rows/validate`): the same opt-in as a page of rows,
 * a strict body, and no value in any error or log. (The checks themselves are in the adapter's tests.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as createConnection } from "./connections/route";
import { PUT as setDataAccess } from "./connections/[id]/data-access/route";
import { POST as validate } from "./connections/[id]/rows/validate/route";

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
  call(validate(json(`${BASE}/connections/x/rows/validate`, "POST", body), params({ id })));
const ask = {
  schema: "public",
  table: "users",
  mode: "insert",
  columns: ["email"],
  rows: [["a@x.test"]],
};

describe("POST /connections/:id/rows/validate", () => {
  it("is refused (403) while data access is off, before anything is checked", async () => {
    const id = await connect();
    const result = await check(id, ask);
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("data_access_disabled");
  });

  it("is refused again after data access is switched off", async () => {
    const id = await connect({ dataAccess: true });
    await call(
      setDataAccess(
        json(`${BASE}/connections/x/data-access`, "PUT", { enabled: false }),
        params({ id }),
      ),
    );
    expect((await check(id, ask)).status).toBe(403);
  });

  it("answers 404 for an unknown connection", async () => {
    expect((await check("unknown-connection-id-0000", ask)).status).toBe(404);
  });

  it.each([
    ["no rows", { ...ask, rows: [] }],
    ["more than 1,000 rows", { ...ask, rows: Array(1001).fill(["x"]) }],
    ["more than 50 values in a row", { ...ask, rows: [Array(51).fill("x")] }],
    ["a mode that does not exist", { ...ask, mode: "delete" }],
    ["a where clause", { ...ask, where: "id > 0" }],
    ["a sql field", { ...ask, sql: "select 1" }],
    ["a value that is not text or null", { ...ask, rows: [[5]] }],
    ["a value that is too long", { ...ask, rows: [["x".repeat(100_001)]] }],
    ["a key with an extra field", { ...ask, key: [{ column: "id", value: "1", op: "gt" }] }],
    ["more than 50 columns", { ...ask, columns: Array.from({ length: 51 }, (_, i) => `c${i}`) }],
  ])("refuses %s with 400 validation_error", async (_name, body) => {
    const id = await connect({ dataAccess: true });
    const result = await check(id, body);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("validation_error");
  });

  it("refuses a body that is too large with 413", async () => {
    const id = await connect({ dataAccess: true });
    const big = { ...ask, rows: Array(30).fill(["x".repeat(50_000)]) };
    expect((await check(id, big)).status).toBe(413);
  });

  it("asks the adapter, and an error holds no value of the request", async () => {
    const id = await connect({ dataAccess: true });
    const secret = "hunter2-SECRET-VALUE";
    // The mock has nothing to check against, so the answer is a fixed error.
    const result = await check(id, { ...ask, rows: [[secret]], table: "users" });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.text).not.toContain(secret);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it("is never cached", async () => {
    const id = await connect({ dataAccess: true });
    const r = await validate(
      json(`${BASE}/connections/x/rows/validate`, "POST", ask),
      params({ id }),
    );
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});
