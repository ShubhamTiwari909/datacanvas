/**
 * Route tests for viewing table data: the opt-in, the page of rows, and that no
 * value ever ends up in an error, a response it should not be in, or a log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseError } from "@datacanvas/database-core";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as createConnection } from "./connections/route";
import { PUT as setDataAccess } from "./connections/[id]/data-access/route";
import { POST as readRows } from "./connections/[id]/rows/route";
import { GET as listProfiles } from "./profiles/route";

const BASE = "http://127.0.0.1:4747/api";
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

// Loosely typed on purpose: these tests probe many response shapes (shapes are checked by Zod elsewhere).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(
  response: Promise<Response> | Response,
): Promise<{ status: number; body: Json; text: string; headers: Headers }> {
  const r = await response;
  const text = await r.text();
  let body: Json;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: r.status, body, text, headers: r.headers };
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
const rows = (id: string, body: unknown) =>
  call(readRows(json(`${BASE}/connections/x/rows`, "POST", body), params({ id })));
const toggle = (id: string, body: unknown) =>
  call(setDataAccess(json(`${BASE}/connections/x/data-access`, "PUT", body), params({ id })));
const users = { schema: "public", table: "users" };

describe("POST /connections/:id/rows", () => {
  it("is refused (403) while data access is off, with a fixed message", async () => {
    const id = await connect();
    const result = await rows(id, users);
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("data_access_disabled");
    expect(result.body.error.message).toBe(
      "Viewing table data is switched off for this connection. Switch it on to see rows.",
    );
  });

  it("returns a page once switched on, and is never cached", async () => {
    const id = await connect();
    expect((await toggle(id, { enabled: true })).body.connection.dataAccess).toBe(true);

    const result = await rows(id, { ...users, pageSize: 2 });

    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body.page.rows.map((r: Json) => r[0].value)).toEqual(["1", "2"]);
    expect(result.body.page.order).toEqual({ kind: "primary_key", columns: ["id"] });
    expect(result.body.page.nextCursor).toEqual(expect.any(String));
  });

  it("can be switched on when connecting", async () => {
    const id = await connect({ dataAccess: true });
    expect((await rows(id, users)).status).toBe(200);
  });

  it("follows a cursor to the next page", async () => {
    const id = await connect({ dataAccess: true });
    const first = await rows(id, { ...users, pageSize: 2 });
    const second = await rows(id, { ...users, pageSize: 2, cursor: first.body.page.nextCursor });
    expect(second.body.page.rows.map((r: Json) => r[0].value)).toEqual(["3"]);
    expect(second.body.page.nextCursor).toBeNull();
  });

  it("refuses again after it is switched off", async () => {
    const id = await connect({ dataAccess: true });
    await toggle(id, { enabled: false });
    expect((await rows(id, users)).status).toBe(403);
  });

  it.each([
    ["no table", { schema: "public" }],
    ["a page size of 500", { ...users, pageSize: 500 }],
    ["a page size of 0", { ...users, pageSize: 0 }],
    ["a where clause", { ...users, where: "id > 0" }],
    ["an orderBy", { ...users, orderBy: "email" }],
    ["a sql field", { ...users, sql: "select * from users" }],
    ["a cursor that is not text", { ...users, cursor: 5 }],
  ])("refuses %s with 400 validation_error", async (_name, body) => {
    const id = await connect({ dataAccess: true });
    const result = await rows(id, body);
    expect(result).toMatchObject({ status: 400, body: { error: { code: "validation_error" } } });
  });

  it("requires a JSON body (415) and valid JSON (400)", async () => {
    const id = await connect({ dataAccess: true });
    const noType = await call(
      readRows(new Request(`${BASE}/x`, { method: "POST", body: "{}" }), params({ id })),
    );
    expect(noType.status).toBe(415);
    const broken = await call(
      readRows(
        new Request(`${BASE}/x`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
        params({ id }),
      ),
    );
    expect(broken).toMatchObject({ status: 400, body: { error: { code: "invalid_json" } } });
  });

  it("answers 404 for an unknown connection and for an unknown table", async () => {
    expect(await rows("missing", users)).toMatchObject({
      status: 404,
      body: { error: { code: "connection_not_found" } },
    });
    const id = await connect({ dataAccess: true });
    expect(await rows(id, { ...users, table: "no_such_table" })).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
    });
  });

  it("answers a cursor that is not valid with 400 invalid_request, and never repeats it", async () => {
    const id = await connect({ dataAccess: true });
    const forged = "FORGED-CURSOR-VALUE-12345";
    const result = await rows(id, { ...users, cursor: forged });
    expect(result).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(result.text).not.toContain(forged);
  });

  it("never contains the connection's password", async () => {
    const id = await connect({ dataAccess: true });
    const texts = [
      (await rows(id, users)).text,
      (await rows(id, { ...users, table: "missing" })).text,
      (await toggle(id, { enabled: true })).text,
    ];
    for (const text of texts) expect(text).not.toContain("s3cret-pw");
  });
});

describe("a sort and conditions in POST /connections/:id/rows", () => {
  const ids = (result: { body: Json }): string[] =>
    result.body.page.rows.map((r: Json) => r[0].value);

  it("sorts by a column and says what it did", async () => {
    const id = await connect({ dataAccess: true });
    const result = await rows(id, { ...users, sort: { column: "email", direction: "desc" } });
    expect(result.status).toBe(200);
    expect(ids(result)).toEqual(["3", "2", "1"]);
    expect(result.body.page.sort).toEqual({ column: "email", direction: "desc" });
    expect(result.body.page.order).toEqual({ kind: "primary_key", columns: ["id"] });
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  it("pages a sorted read by its cursor, which carries the sort value", async () => {
    const id = await connect({ dataAccess: true });
    const sort = { column: "email", direction: "desc" };
    const first = await rows(id, { ...users, sort, pageSize: 2 });
    expect(ids(first)).toEqual(["3", "2"]);
    const second = await rows(id, {
      ...users,
      sort,
      pageSize: 2,
      cursor: first.body.page.nextCursor,
    });
    expect(ids(second)).toEqual(["1"]);
    expect(second.body.page.nextCursor).toBeNull();
  });

  it("narrows by conditions and echoes them in the order given", async () => {
    const id = await connect({ dataAccess: true });
    const filters = [
      { column: "id", op: "gte", value: "2" },
      { column: "email", op: "contains", value: "C@" },
    ];
    const result = await rows(id, { ...users, filters });
    expect(ids(result)).toEqual(["3"]);
    expect(result.body.page.filters).toEqual(filters);
    expect((await rows(id, users)).body.page.filters).toEqual([]);
  });

  it("combines a sort, conditions and a cursor", async () => {
    const id = await connect({ dataAccess: true });
    const body = {
      ...users,
      sort: { column: "email", direction: "desc" },
      filters: [{ column: "email", op: "neq", value: "b@x.test" }],
      pageSize: 1,
    };
    const first = await rows(id, body);
    expect(ids(first)).toEqual(["3"]);
    const second = await rows(id, { ...body, cursor: first.body.page.nextCursor });
    expect(ids(second)).toEqual(["1"]);
  });

  it("answers the same refusal while data access is off, with or without them, and for any table", async () => {
    const id = await connect();
    const plain = await rows(id, users);
    for (const body of [
      { ...users, sort: { column: "email", direction: "asc" } },
      { ...users, filters: [{ column: "email", op: "is_null" }] },
      { ...users, table: "no_such_table", sort: { column: "x", direction: "asc" } },
    ]) {
      const result = await rows(id, body);
      expect(result.status).toBe(403);
      expect(result.body).toEqual(plain.body);
    }
  });

  it.each([
    ["a sort that is text", { sort: "email" }],
    ["a sort with another direction", { sort: { column: "email", direction: "up" } }],
    ["a sort with an extra key", { sort: { column: "email", direction: "asc", nulls: "first" } }],
    ["four conditions", { filters: Array(4).fill({ column: "email", op: "neq", value: "z" }) }],
    ["an operator that does not exist", { filters: [{ column: "email", op: "like", value: "%" }] }],
    ["a missing value", { filters: [{ column: "email", op: "eq" }] }],
    ["a value on is_null", { filters: [{ column: "email", op: "is_null", value: "x" }] }],
    [
      "a value over 200 characters",
      { filters: [{ column: "email", op: "eq", value: "v".repeat(201) }] },
    ],
    [
      "a condition with a where inside",
      { filters: [{ column: "id", op: "eq", value: "1", where: "1=1" }] },
    ],
    ["a condition written as text", { filters: ["id > 0"] }],
  ])("refuses %s with 400 validation_error", async (_name, extra) => {
    const id = await connect({ dataAccess: true });
    const result = await rows(id, { ...users, ...extra });
    expect(result).toMatchObject({ status: 400, body: { error: { code: "validation_error" } } });
  });

  const FORGED_COLUMN = "forged_column_name_98765";
  const FORGED_VALUE = "FORGED-FILTER-VALUE-98765";
  it.each([
    [
      "a sort by a column that does not exist",
      { sort: { column: FORGED_COLUMN, direction: "asc" } },
    ],
    [
      "a condition on a column that does not exist",
      { filters: [{ column: FORGED_COLUMN, op: "is_null" }] },
    ],
    ["contains on a number", { filters: [{ column: "id", op: "contains", value: FORGED_VALUE }] }],
    [
      "a value that does not fit the column",
      { filters: [{ column: "id", op: "eq", value: FORGED_VALUE }] },
    ],
  ])(
    "answers %s with 400 invalid_request, never repeating the name or the value",
    async (_name, extra) => {
      const id = await connect({ dataAccess: true });
      const result = await rows(id, { ...users, ...extra });
      expect(result).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
      expect(result.text).not.toContain(FORGED_COLUMN);
      expect(result.text).not.toContain(FORGED_VALUE);
      expect(JSON.stringify(logged)).not.toContain(FORGED_VALUE);
    },
  );

  it("answers a cursor from a different sort with 400 invalid_request", async () => {
    const id = await connect({ dataAccess: true });
    const plain = await rows(id, { ...users, pageSize: 1 });
    const result = await rows(id, {
      ...users,
      cursor: plain.body.page.nextCursor,
      sort: { column: "email", direction: "asc" },
    });
    expect(result).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
  });

  it("answers a read that was stopped for taking too long with 422 and a fixed message", async () => {
    const id = await connect({ dataAccess: true });
    context.createdAdapters[0]!.getRows = async () => {
      throw new DatabaseError("too_slow", {
        cause: new Error("canceling statement: FORGED-FILTER-VALUE-98765"),
      });
    };
    const result = await rows(id, { ...users, sort: { column: "email", direction: "asc" } });
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("too_slow");
    expect(result.body.error.message).toMatch(/longer than 5 seconds/);
    expect(result.text).not.toContain("FORGED-FILTER-VALUE-98765");
    expect(JSON.stringify(logged)).not.toContain("FORGED-FILTER-VALUE-98765");
  });

  it("writes nothing to the console, and the value of a condition is in no response but the page's echo", async () => {
    const id = await connect({ dataAccess: true });
    const value = "CONDITION-VALUE-NEVER-LOGGED";
    const ok = await rows(id, { ...users, filters: [{ column: "email", op: "contains", value }] });
    expect(ok.status).toBe(200);
    expect(ok.body.page.rows).toEqual([]);
    expect(logged).toEqual([]);
    // Other routes never see it.
    const other = await toggle(id, { enabled: true });
    expect(other.text).not.toContain(value);
  });

  it("an unexpected failure that mentions the value of a condition is logged by name only", async () => {
    const id = await connect({ dataAccess: true });
    const value = "CONDITION-VALUE-IN-A-DRIVER-MESSAGE";
    context.createdAdapters[0]!.getRows = async () => {
      throw new Error(`invalid input syntax for type integer: "${value}"`);
    };
    const result = await rows(id, { ...users, filters: [{ column: "id", op: "eq", value }] });
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe("unexpected");
    expect(result.text).not.toContain(value);
    expect(JSON.stringify(logged)).not.toContain(value);
  });

  it("never contains the connection's password", async () => {
    const id = await connect({ dataAccess: true });
    const texts = [
      (await rows(id, { ...users, sort: { column: "email", direction: "asc" } })).text,
      (await rows(id, { ...users, filters: [{ column: "nope", op: "is_null" }] })).text,
    ];
    for (const text of texts) expect(text).not.toContain("s3cret-pw");
  });
});

describe("a value never reaches a log or an error", () => {
  const SECRET = "ROW-VALUE-NEVER-LOGGED-98765";

  it("an unexpected failure that mentions a value is logged by name only, and answered with a fixed message", async () => {
    const id = await connect({ dataAccess: true });
    context.createdAdapters[0]!.getRows = async () => {
      throw new Error(`duplicate key value violates unique constraint: Key (email)=(${SECRET})`);
    };

    const result = await rows(id, users);

    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe("unexpected");
    expect(result.text).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it("a successful read writes nothing to the console", async () => {
    const id = await connect({ dataAccess: true });
    const page = await rows(id, users);
    expect(page.status).toBe(200);
    expect(logged).toEqual([]);
  });

  it("an error from the adapter that carries the value as its cause is not logged with it", async () => {
    const id = await connect({ dataAccess: true });
    context.createdAdapters[0]!.getRows = async () => {
      throw Object.assign(new Error("failed"), { cause: new Error(`bad value ${SECRET}`) });
    };
    const result = await rows(id, users);
    expect(result.text).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });
});

describe("PUT /connections/:id/data-access", () => {
  it("answers with the updated connection", async () => {
    const id = await connect();
    const on = await toggle(id, { enabled: true });
    expect(on).toMatchObject({ status: 200, body: { connection: { id, dataAccess: true } } });
    expect(on.headers.get("cache-control")).toBe("no-store");
    expect((await toggle(id, { enabled: false })).body.connection.dataAccess).toBe(false);
  });

  it.each([
    ["an empty body", {}],
    ["a text value", { enabled: "yes" }],
    ["an extra key", { enabled: true, x: 1 }],
  ])("refuses %s with 400", async (_name, body) => {
    const id = await connect();
    expect((await toggle(id, body)).status).toBe(400);
  });

  it("answers 404 for an unknown connection", async () => {
    expect(await toggle("missing", { enabled: true })).toMatchObject({
      status: 404,
      body: { error: { code: "connection_not_found" } },
    });
  });

  it("is remembered with a saved connection, and shown in the list of saved connections", async () => {
    const id = await connect({ remember: true });
    await toggle(id, { enabled: true });
    const { body } = await call(listProfiles(new Request(`${BASE}/profiles`)));
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].dataAccess).toBe(true);
    expect(JSON.stringify(body)).not.toContain("s3cret-pw");
  });
});
