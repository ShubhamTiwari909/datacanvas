/**
 * Route tests for exporting rows as a file (`POST /connections/:id/rows/export`): the same opt-in as a page of rows,
 * a strict body, the file as the answer with its headers, and no value in any error or log. (The reader of rows is tested against PostgreSQL in the adapter's tests.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError, type ExportEvent } from "@datacanvas/database-core";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as createConnection } from "./connections/route";
import { POST as exportRows } from "./connections/[id]/rows/export/route";

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
const post = (id: string, body: unknown) =>
  exportRows(json(`${BASE}/connections/x/rows/export`, "POST", body), params({ id }));
const ask = { schema: "public", table: "users", format: "csv" };
const columns = [{ name: "id", dataType: "integer" }];
function script(run: (sink: (e: ExportEvent) => unknown) => Promise<void>): void {
  vi.spyOn(context.createdAdapters[0]!, "exportRows").mockImplementation(async (_t, _o, sink) =>
    run(sink as (e: ExportEvent) => unknown),
  );
}

describe("POST /connections/:id/rows/export", () => {
  it("is refused (403) while data access is off, before anything is read", async () => {
    const id = await connect();
    const spy = vi.spyOn(context.createdAdapters[0]!, "exportRows");
    const result = await call(post(id, ask));
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("data_access_disabled");
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown connection", async () => {
    expect((await call(post("unknown-connection-id-0000", ask))).status).toBe(404);
  });

  it.each([
    ["no format", { schema: "public", table: "users" }],
    ["a format that does not exist", { ...ask, format: "xlsx" }],
    ["a delimiter that is not allowed", { ...ask, delimiter: "|" }],
    ["a where clause", { ...ask, where: "1=1" }],
    ["a sql field", { ...ask, sql: "select 1" }],
    ["a NULL word that is too long", { ...ask, nullText: "x".repeat(51) }],
    [
      "more than ten conditions",
      { ...ask, filters: Array(11).fill({ column: "a", op: "is_null" }) },
    ],
    ["a limit field", { ...ask, limit: 5 }],
    ["an empty list of keys", { ...ask, keys: [] }],
    ["more than 500 keys", { ...ask, keys: Array(501).fill([{ column: "id", value: "1" }]) }],
    ["a key with no column", { ...ask, keys: [[]] }],
    [
      "a key with a field that is not a column and a value",
      { ...ask, keys: [[{ column: "id", value: "1", where: "x" }]] },
    ],
    [
      "a key value over 4,096 characters",
      { ...ask, keys: [[{ column: "id", value: "x".repeat(4097) }]] },
    ],
    ["a header that is not a boolean", { ...ask, header: "yes" }],
  ])("refuses %s with 400 validation_error", async (_name, body) => {
    const id = await connect({ dataAccess: true });
    const result = await call(post(id, body));
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("validation_error");
  });

  it("answers with the file itself, never cached, never sniffed, as an attachment", async () => {
    const id = await connect({ dataAccess: true });
    script(async (sink) => {
      await sink({ kind: "start", columns, leftOut: [] });
      await sink({ kind: "rows", rows: [["1"], ["2"]], cellsCut: 0 });
      await sink({ kind: "end", rows: 2, cut: null, cellsCut: 0 });
    });
    const response = await post(id, { ...ask, format: "tsv" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/tab-separated-values; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("id\r\n1\r\n2\r\n");
  });

  it("passes the chosen keys to the reader, says a count (never the keys) in the notes, and writes the SQL script as a file", async () => {
    const id = await connect({ dataAccess: true });
    let received: unknown;
    vi.spyOn(context.createdAdapters[0]!, "exportRows").mockImplementation(
      async (_t, options, sink) => {
        received = options.keys;
        const emit = sink as (e: ExportEvent) => unknown;
        await emit({ kind: "start", columns, leftOut: [] });
        await emit({ kind: "rows", rows: [["7"]], cellsCut: 0 });
        await emit({ kind: "end", rows: 1, cut: null, cellsCut: 0 });
      },
    );
    const secretKey = "key-value-SECRET";
    const response = await post(id, {
      ...ask,
      format: "sql",
      keys: [[{ column: "id", value: secretKey }]],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/sql; charset=utf-8");
    expect(received).toEqual([[{ column: "id", value: secretKey }]]);
    const text = await response.text();
    expect(text).toContain("BEGIN;");
    expect(text.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(text).not.toContain(secretKey);
    expect(JSON.stringify(logged)).not.toContain(secretKey);
  });

  it("answers an error known before the first byte in the usual JSON, with no value in it or in a log", async () => {
    const id = await connect({ dataAccess: true });
    const secret = "hunter2-SECRET-VALUE";
    // The mock has no rows to write: it says so before it starts.
    const result = await call(
      post(id, { ...ask, filters: [{ column: "email", op: "eq", value: secret }] }),
    );
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("not_supported");
    expect(result.text).not.toContain(secret);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it("does not repeat a value the database named in its error, in the answer or a log", async () => {
    const id = await connect({ dataAccess: true });
    const secret = "hunter2-SECRET-IN-ERROR";
    script(async () => {
      throw new DatabaseError("invalid_request", {
        cause: new Error(`invalid input syntax: "${secret}"`),
      });
    });
    const result = await call(post(id, ask));
    expect(result.status).toBe(400);
    expect(result.text).not.toContain(secret);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it("allows one export at a time per connection, with 429", async () => {
    const id = await connect({ dataAccess: true });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    script(async (sink) => {
      await sink({ kind: "start", columns, leftOut: [] });
      await held;
      await sink({ kind: "end", rows: 0, cut: null, cellsCut: 0 });
    });
    const first = await post(id, ask);
    const second = await call(post(id, ask));
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe("export_busy");
    release();
    await first.text();
  });
});
