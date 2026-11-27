/**
 * Route tests for reading one JSON or text value whole (`POST /connections/:id/rows/cell`): the same opt-in as
 * a page of rows, a strict body, an answer that says whether the whole value can be edited, and no value in
 * any error.
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

  // -------- a cut text value, read whole to be edited (E5a) --------

  it("answers with the value, its length and whether the whole value can be edited, never cached", async () => {
    const id = await connect({ dataAccess: true });
    const read = vi
      .spyOn(context.createdAdapters.at(-1)!, "getCell")
      .mockResolvedValue({ value: "the whole text", tooLarge: false, length: 14, editable: true });
    const body = { ...ask, column: "bio" };
    const r = await readCell(json(`${BASE}/connections/x/rows/cell`, "POST", body), params({ id }));
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({
      cell: { value: "the whole text", tooLarge: false, length: 14, editable: true },
    });
    expect(read).toHaveBeenCalledWith(
      { schema: "public", name: "users" },
      { column: "bio", key: [{ column: "id", value: "1" }], revealColumns: [] },
    );
  });

  it("passes a value that is too long to edit through with its length and editable false", async () => {
    const id = await connect({ dataAccess: true });
    vi.spyOn(context.createdAdapters.at(-1)!, "getCell").mockResolvedValue({
      value: "x".repeat(100_001),
      tooLarge: false,
      length: 100_001,
      editable: false,
    });
    const result = await cell(id, { ...ask, column: "bio" });
    expect(result.status).toBe(200);
    expect(result.body.cell.editable).toBe(false);
    expect(result.body.cell.length).toBe(100_001);
    expect(result.body.cell.value).toHaveLength(100_001);
  });

  it("passes a value that is too large to read through without the text", async () => {
    const id = await connect({ dataAccess: true });
    vi.spyOn(context.createdAdapters.at(-1)!, "getCell").mockResolvedValue({
      value: null,
      tooLarge: true,
      length: 1_000_001,
      editable: false,
    });
    const result = await cell(id, { ...ask, column: "bio" });
    expect(result.body.cell).toEqual({
      value: null,
      tooLarge: true,
      length: 1_000_001,
      editable: false,
    });
  });

  it("is refused before the adapter is asked while data access is off, for a text column too", async () => {
    const id = await connect();
    const read = vi.spyOn(context.createdAdapters.at(-1)!, "getCell");
    const result = await cell(id, { ...ask, column: "bio" });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("data_access_disabled");
    expect(read).not.toHaveBeenCalled();
  });

  it("logs and echoes no value of a text cell", async () => {
    const id = await connect({ dataAccess: true });
    const secret = "hunter2-SECRET-TEXT";
    vi.spyOn(context.createdAdapters.at(-1)!, "getCell").mockResolvedValue({
      value: secret,
      tooLarge: false,
      length: secret.length,
      editable: true,
    });
    await cell(id, { ...ask, column: "bio" });
    expect(JSON.stringify(logged)).not.toContain(secret);
    // An error from the adapter is answered with a fixed text.
    vi.spyOn(context.createdAdapters.at(-1)!, "getCell").mockRejectedValue(
      Object.assign(new Error(`bad ${secret}`), { name: "DatabaseError", code: "invalid_request" }),
    );
    const failed = await cell(id, { ...ask, column: "bio" });
    expect(failed.text).not.toContain(secret);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
});
