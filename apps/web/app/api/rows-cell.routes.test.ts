/**
 * Route tests for reading one JSON value whole (`POST /connections/:id/rows/cell`): the same opt-in as
 * a page of rows, a strict body, and no value in any error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as createConnection } from "./connections/route";
import { PUT as setDataAccess } from "./connections/[id]/data-access/route";
import { POST as readCell } from "./connections/[id]/rows/cell/route";

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
const cell = (id: string, body: unknown) =>
  call(readCell(json(`${BASE}/connections/x/rows/cell`, "POST", body), params({ id })));
const ask = {
  schema: "public",
  table: "users",
  column: "settings",
  key: [{ column: "id", value: "1" }],
};

describe("POST /connections/:id/rows/cell", () => {
  it("is refused (403) while data access is off, before anything is read", async () => {
    const id = await connect();
    const result = await cell(id, ask);
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
    expect((await cell(id, ask)).status).toBe(403);
  });

  it("answers 404 for an unknown connection", async () => {
    expect((await cell("unknown-connection-id-0000", ask)).status).toBe(404);
  });

  it.each([
    ["no key", { ...ask, key: [] }],
    ["no column", { schema: "public", table: "users", key: ask.key }],
    ["a where clause", { ...ask, where: "id > 0" }],
    ["a sql field", { ...ask, sql: "select 1" }],
    ["a key value that is not text", { ...ask, key: [{ column: "id", value: 1 }] }],
    ["an extra key in a key entry", { ...ask, key: [{ column: "id", value: "1", op: "gt" }] }],
    ["more than 32 key columns", { ...ask, key: Array(33).fill({ column: "id", value: "1" }) }],
  ])("refuses %s with 400 validation_error", async (_name, body) => {
    const id = await connect({ dataAccess: true });
    const result = await cell(id, body);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("validation_error");
  });

  it("asks the adapter and answers with fixed text, never repeating a key value or a name", async () => {
    const id = await connect({ dataAccess: true });
    const secret = "hunter2-SECRET-KEY";
    const result = await cell(id, { ...ask, key: [{ column: "id", value: secret }] });
    // The sample database has no JSON column to read: the adapter says invalid_request.
    expect(result.status).toBe(400);
    expect(result.text).not.toContain(secret);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it("is never cached", async () => {
    const id = await connect({ dataAccess: true });
    const r = await readCell(json(`${BASE}/connections/x/rows/cell`, "POST", ask), params({ id }));
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});
