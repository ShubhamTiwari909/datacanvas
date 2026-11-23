/**
 * Route tests for editing rows and designing tables: the three switches, the
 * strict bodies (no SQL anywhere), preview then apply, the session history and
 * the role warnings, and that no value ever ends up in an error, a response it
 * should not be in, or a log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_MAX_BODY_BYTES } from "@datacanvas/shared-types";
import type { MockDatabaseAdapter } from "@datacanvas/database-core/testing";
import { MOCK_ROLE } from "@datacanvas/database-core/testing";
import { setServerContextForTests } from "@/lib/server/context";
import { createTestContext, fieldsInput, type TestContext } from "@/lib/server/test-support";
import { POST as createConnection } from "./connections/route";
import { PUT as setDataAccess } from "./connections/[id]/data-access/route";
import { GET as getStatus } from "./connections/[id]/writes/route";
import { POST as unlock } from "./connections/[id]/writes/unlock/route";
import { POST as lock } from "./connections/[id]/writes/lock/route";
import { POST as editInfo } from "./connections/[id]/writes/edit-info/route";
import { POST as previewChange } from "./connections/[id]/writes/preview/route";
import { POST as applyChange } from "./connections/[id]/writes/apply/route";
import { GET as getHistory } from "./connections/[id]/writes/history/route";
import { GET as getMigration } from "./connections/[id]/writes/migration/route";
import { GET as getRole } from "./connections/[id]/role/route";
import { POST as readRows } from "./connections/[id]/rows/route";

const BASE = "http://127.0.0.1:4747/api";
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

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

const json = (url: string, method: string, body: unknown, headers: HeadersInit = {}): Request =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** A value that must never appear in an error, a log or a response that should not hold it. */
const SECRET = "zz-distinctive-value-9f3a";
const users = { schema: "public", name: "users" };

let context: TestContext;
let logged: unknown[][];
function start(writesEnabled: boolean) {
  context = createTestContext({}, { writesEnabled });
  setServerContextForTests(context);
}
beforeEach(() => {
  start(true);
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
const at = (id: string, path: string) => `${BASE}/connections/${id}/${path}`;
const status = (id: string) => call(getStatus(new Request(at(id, "writes")), params({ id })));
const unlockWith = (id: string, body: unknown) =>
  call(unlock(json(at(id, "writes/unlock"), "POST", body), params({ id })));
const lockIt = (id: string) => call(lock(json(at(id, "writes/lock"), "POST", {}), params({ id })));
const info = (id: string, body: unknown) =>
  call(editInfo(json(at(id, "writes/edit-info"), "POST", body), params({ id })));
const preview = (id: string, body: unknown) =>
  call(previewChange(json(at(id, "writes/preview"), "POST", body), params({ id })));
const apply = (id: string, body: unknown) =>
  call(applyChange(json(at(id, "writes/apply"), "POST", body), params({ id })));
const history = (id: string) =>
  call(getHistory(new Request(at(id, "writes/history")), params({ id })));
const migration = (id: string) =>
  call(getMigration(new Request(at(id, "writes/migration")), params({ id })));
const rows = (id: string) =>
  call(
    readRows(
      json(at(id, "rows"), "POST", { schema: "public", table: "users", pageSize: 10 }),
      params({ id }),
    ),
  );

/** A connection that is ready to be edited: data viewing on and writes unlocked. */
async function unlocked(): Promise<string> {
  const id = await connect({ dataAccess: true });
  expect((await unlockWith(id, { database: "shop" })).status).toBe(200);
  return id;
}

const updateEmail = (value: string, seen = "a@x.test") => ({
  change: {
    kind: "update_row",
    table: users,
    key: [{ column: "id", value: "1" }],
    set: [{ column: "email", value }],
    expected: [{ column: "email", value: seen }],
  },
});

describe("writes are off unless DataCanvas was started with --enable-writes", () => {
  it("says so, and refuses every route", async () => {
    start(false);
    const id = await connect({ dataAccess: true });
    expect((await status(id)).body.writes).toEqual({
      enabled: false,
      local: true,
      dataAccess: true,
      unlocked: false,
    });
    const refused = await unlockWith(id, { database: "shop" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("writes_not_enabled");
    expect(refused.body.error.message).toContain("--enable-writes");
    // Nothing else can get past either.
    for (const result of [
      await info(id, { schema: "public", table: "users" }),
      await preview(id, updateEmail("x")),
      await apply(id, { previewId: "p".repeat(22) }),
    ]) {
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("writes_not_enabled");
    }
  });
});

describe("the switches and the unlock", () => {
  it("answers the four switches, never cached", async () => {
    const id = await connect();
    const result = await status(id);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body.writes).toEqual({
      enabled: true,
      local: true,
      dataAccess: false,
      unlocked: false,
    });
  });

  it("refuses a database that is not on this machine (403) with the fixed sentence", async () => {
    const id = await connect({ host: "db.example.com", dataAccess: true });
    expect((await status(id)).body.writes.local).toBe(false);
    const result = await unlockWith(id, { database: "shop" });
    expect(result.status).toBe(403);
    expect(result.body.error).toEqual({
      code: "writes_not_allowed_here",
      message:
        "Writes are only available on a database running on this machine. This connection stays read-only.",
    });
  });

  it("needs data viewing (403), then the exact database name (400, not echoed)", async () => {
    const id = await connect();
    expect((await unlockWith(id, { database: "shop" })).body.error.code).toBe(
      "data_access_disabled",
    );
    await call(
      setDataAccess(json(at(id, "data-access"), "PUT", { enabled: true }), params({ id })),
    );
    const wrong = await unlockWith(id, { database: SECRET });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("wrong_database_name");
    expect(wrong.text).not.toContain(SECRET);
    const right = await unlockWith(id, { database: "shop" });
    expect(right.body.writes).toEqual({
      enabled: true,
      local: true,
      dataAccess: true,
      unlocked: true,
    });
  });

  it("locks again, and switching data viewing off locks too", async () => {
    const id = await unlocked();
    expect((await lockIt(id)).body.writes.unlocked).toBe(false);
    await unlockWith(id, { database: "shop" });
    await call(
      setDataAccess(json(at(id, "data-access"), "PUT", { enabled: false }), params({ id })),
    );
    expect((await status(id)).body.writes).toMatchObject({ dataAccess: false, unlocked: false });
  });

  it("is not remembered in a saved connection or in the connection's summary", async () => {
    const id = await connect({ dataAccess: true, remember: true });
    await unlockWith(id, { database: "shop" });
    const profiles = JSON.stringify(await context.profiles.list());
    expect(profiles).not.toMatch(/unlock|writes/i);
    expect(JSON.stringify(context.connections.listConnections())).not.toMatch(/unlock|writes/i);
  });

  it("answers 404 for an unknown connection", async () => {
    expect((await status("missing-connection-id")).status).toBe(404);
    expect((await unlockWith("missing-connection-id", { database: "shop" })).status).toBe(404);
  });

  it("is locked again for a new connection to the same database", async () => {
    const id = await unlocked();
    await context.connections.deleteConnection(id);
    const again = await connect({ dataAccess: true });
    expect((await status(again)).body.writes.unlocked).toBe(false);
  });
});

describe("edit info", () => {
  it("is refused while locked, and describes a table once unlocked", async () => {
    const id = await connect({ dataAccess: true });
    expect((await info(id, { schema: "public", table: "users" })).body.error.code).toBe(
      "write_not_unlocked",
    );
    await unlockWith(id, { database: "shop" });
    const result = await info(id, { schema: "public", table: "users" });
    expect(result.status).toBe(200);
    expect(result.body.info).toMatchObject({ editable: true, key: ["id"], reason: null });
    expect(result.body.info.columns.map((c: Json) => c.name)).toEqual([
      "id",
      "email",
      "full_name",
      "created_at",
    ]);
    expect(result.body.info.incomingForeignKeys.length).toBeGreaterThan(0);
  });

  it("says 404 for a table that does not exist", async () => {
    const id = await unlocked();
    expect((await info(id, { schema: "public", table: "nope" })).status).toBe(404);
  });
});

describe("preview then apply", () => {
  it("previews without values, changes nothing, then applies exactly that, once", async () => {
    const id = await unlocked();
    const planned = await preview(id, updateEmail("new@x.test"));
    expect(planned.status).toBe(200);
    expect(planned.headers.get("cache-control")).toBe("no-store");
    expect(planned.body.preview).toMatchObject({
      category: "row",
      destructive: false,
      previewId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });
    expect(planned.body.preview.statement).toContain('UPDATE "public"."users"');
    expect(planned.text).not.toContain("new@x.test");
    // Not applied yet.
    expect((await rows(id)).body.page.rows[0][1].value).toBe("a@x.test");

    const done = await apply(id, { previewId: planned.body.preview.previewId });
    expect(done.status).toBe(200);
    expect(done.headers.get("cache-control")).toBe("no-store");
    expect(done.body.result.rowCount).toBe(1);
    expect(done.body.result.entry).toMatchObject({ kind: "update_row", outcome: "applied" });
    expect((await rows(id)).body.page.rows[0][1].value).toBe("new@x.test");

    const again = await apply(id, { previewId: planned.body.preview.previewId });
    expect(again).toMatchObject({ status: 410, body: { error: { code: "preview_expired" } } });
  });

  it("answers 409 row_changed when someone else changed the row, writing nothing", async () => {
    const id = await unlocked();
    const planned = await preview(id, updateEmail(SECRET, "not-what-is-there"));
    const result = await apply(id, { previewId: planned.body.preview.previewId });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("row_changed");
    expect(result.text).not.toContain(SECRET);
    expect((await rows(id)).body.page.rows[0][1].value).toBe("a@x.test");
  });

  it("inserts and deletes a row", async () => {
    const id = await unlocked();
    const inserted = await apply(id, {
      previewId: (
        await preview(id, {
          change: {
            kind: "insert_row",
            table: users,
            values: [{ column: "email", value: "d@x.test" }],
          },
        })
      ).body.preview.previewId,
    });
    expect(inserted.body.result.rowCount).toBe(1);
    expect((await rows(id)).body.page.rows).toHaveLength(4);

    const deletion = await preview(id, {
      change: { kind: "delete_row", table: users, key: [{ column: "id", value: "2" }] },
    });
    expect(deletion.body.preview).toMatchObject({ destructive: true, category: "row" });
    expect(deletion.body.preview.warnings.map((w: Json) => w.code)).toContain("destructive");
    await apply(id, { previewId: deletion.body.preview.previewId });
    expect((await rows(id)).body.page.rows).toHaveLength(3);
  });

  it("refuses a unique violation with a fixed message that has no value in it", async () => {
    const id = await unlocked();
    const planned = await preview(id, updateEmail("b@x.test"));
    const result = await apply(id, { previewId: planned.body.preview.previewId });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("unique_violation");
    expect(result.text).not.toContain("b@x.test");
  });

  it("applies a change of structure and keeps its SQL in the history", async () => {
    const id = await unlocked();
    const planned = await preview(id, {
      change: {
        kind: "create_table",
        schema: "public",
        name: "tags",
        columns: [
          {
            name: "id",
            type: { name: "integer" },
            nullable: false,
            default: { kind: "none" },
            identity: "always",
            comment: null,
          },
          {
            name: "label",
            type: { name: "text" },
            nullable: false,
            default: { kind: "none" },
            identity: null,
            comment: null,
          },
        ],
        primaryKey: ["id"],
        unique: [],
        foreignKeys: [],
        comment: null,
      },
    });
    expect(planned.body.preview.category).toBe("structure");
    expect(planned.body.preview.statement).toContain('CREATE TABLE "public"."tags"');
    await apply(id, { previewId: planned.body.preview.previewId });
    const list = (await history(id)).body.history;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: "create_table",
      table: { schema: "public", name: "tags" },
      columns: ["id", "label"],
      outcome: "applied",
    });
    expect(list[0].statement).toContain('CREATE TABLE "public"."tags"');
  });

  it("shows a literal default in the preview but keeps it out of the history", async () => {
    const id = await unlocked();
    const planned = await preview(id, {
      change: {
        kind: "create_table",
        schema: "public",
        name: "tags_typed",
        columns: [
          {
            name: "label",
            type: { name: "text" },
            nullable: true,
            default: { kind: "literal", value: "typed-by-the-person" },
            identity: null,
            comment: "also typed by the person",
          },
        ],
        primaryKey: [],
        unique: [],
        foreignKeys: [],
        comment: null,
      },
    });
    // The person sees exactly what they typed...
    expect(planned.body.preview.statement).toContain("typed-by-the-person");
    await apply(id, { previewId: planned.body.preview.previewId });
    // ...but the session history is names only.
    const [entry] = (await history(id)).body.history;
    expect(entry).toMatchObject({ kind: "create_table", columns: ["label"], statement: null });
    expect(JSON.stringify((await history(id)).body)).not.toContain("typed-by-the-person");
    expect(JSON.stringify((await history(id)).body)).not.toContain("also typed");
    // The migration file is the one place the typed text goes: it is the person's own SQL,
    // asked for on purpose, and it is never part of the history.
    const file = (await migration(id)).body.migration;
    expect(file).toMatchObject({ steps: 1, rowChanges: 0 });
    expect(file.script).toContain("typed-by-the-person");
    expect(file.script).toContain("COMMIT;");
  });

  it("exports the migration of a session and counts the row changes it leaves out", async () => {
    const id = await unlocked();
    const planned = await preview(id, {
      change: {
        kind: "update_row",
        table: users,
        key: [{ column: "id", value: "1" }],
        set: [{ column: "email", value: "row-secret@x.test" }],
        expected: [{ column: "email", value: "a@x.test" }],
      },
    });
    await apply(id, { previewId: planned.body.preview.previewId });
    const result = await migration(id);
    expect(result.status).toBe(200);
    expect(result.body.migration).toMatchObject({ steps: 0, rowChanges: 1 });
    expect(result.text).not.toContain("row-secret@x.test");
    expect((await migration("missing")).status).toBe(404);
  });

  it("refuses a drop without the table's name typed, and a drop that has dependents", async () => {
    const id = await unlocked();
    expect(
      (
        await preview(id, {
          change: { kind: "drop_table", table: users, confirm: "oops" },
        })
      ).body.error.code,
    ).toBe("invalid_change");
    const referenced = await preview(id, {
      change: { kind: "drop_table", table: users, confirm: "users" },
    });
    expect(referenced.status).toBe(409);
    expect(referenced.body.error.code).toBe("has_dependents");
  });

  it("refuses a preview that never existed or has the wrong shape", async () => {
    const id = await unlocked();
    expect(await apply(id, { previewId: "p".repeat(22) })).toMatchObject({
      status: 410,
      body: { error: { code: "preview_expired" } },
    });
    expect((await apply(id, { previewId: "short" })).status).toBe(400);
  });

  it("drops the previews when writes are locked", async () => {
    const id = await unlocked();
    const planned = await preview(id, updateEmail("new@x.test"));
    await lockIt(id);
    await unlockWith(id, { database: "shop" });
    expect((await apply(id, { previewId: planned.body.preview.previewId })).status).toBe(410);
  });
});

describe("the history", () => {
  it("lists the newest first, with names and never values", async () => {
    const id = await unlocked();
    await apply(id, {
      previewId: (await preview(id, updateEmail(SECRET))).body.preview.previewId,
    });
    await apply(id, {
      previewId: (await preview(id, updateEmail("again@x.test", SECRET))).body.preview.previewId,
    });
    const result = await history(id);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body.history).toHaveLength(2);
    expect(result.body.history[0].at >= result.body.history[1].at).toBe(true);
    expect(result.text).not.toContain(SECRET);
    expect(result.text).not.toContain("again@x.test");
    expect(result.body.history[0]).toEqual({
      id: expect.any(String),
      at: expect.any(String),
      kind: "update_row",
      table: users,
      columns: ["email"],
      statement: null,
      outcome: "applied",
      errorCode: null,
    });
  });
});

describe("requests are strict JSON with no SQL anywhere", () => {
  it.each([
    ["a sql field", (c: Json) => ({ ...c, sql: "drop table users" })],
    ["a where field", (c: Json) => ({ ...c, where: "1=1" })],
    ["an expression field", (c: Json) => ({ ...c, expression: "now()" })],
    ["a using field", (c: Json) => ({ ...c, using: "x::int" })],
    ["a sql field in the table", (c: Json) => ({ ...c, table: { ...c.table, sql: "x" } })],
    [
      "a sql field in a value",
      (c: Json) => ({ ...c, set: [{ column: "email", value: "x", sql: "y" }] }),
    ],
    ["an unknown kind", (c: Json) => ({ ...c, kind: "run_sql" })],
  ])("refuses %s with 400 validation_error", async (_name, tweak) => {
    const id = await unlocked();
    const result = await preview(id, { change: tweak(updateEmail("x").change) });
    expect(result).toMatchObject({ status: 400, body: { error: { code: "validation_error" } } });
  });

  it("refuses an extra key beside the change", async () => {
    const id = await unlocked();
    expect((await preview(id, { ...updateEmail("x"), sql: "select 1" })).status).toBe(400);
    expect((await unlockWith(id, { database: "shop", force: true })).status).toBe(400);
    expect((await apply(id, { previewId: "p".repeat(22), sql: "select 1" })).status).toBe(400);
    const lockBody = await call(
      lock(json(at(id, "writes/lock"), "POST", { now: true }), params({ id })),
    );
    expect(lockBody.status).toBe(400);
  });

  it("requires a JSON body (415) and valid JSON (400) on every POST", async () => {
    const id = await unlocked();
    const posts = [
      [unlock, "writes/unlock"],
      [lock, "writes/lock"],
      [editInfo, "writes/edit-info"],
      [previewChange, "writes/preview"],
      [applyChange, "writes/apply"],
    ] as const;
    for (const [handler, path] of posts) {
      const noType = await call(
        handler(new Request(at(id, path), { method: "POST", body: "{}" }), params({ id })),
      );
      expect(noType.status, path).toBe(415);
      const broken = await call(
        handler(
          new Request(at(id, path), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{",
          }),
          params({ id }),
        ),
      );
      expect(broken.status, path).toBe(400);
    }
  });

  it("refuses a body that is too large (413)", async () => {
    const id = await unlocked();
    // The preview takes the size of an import, so a body past that is what is refused as too large.
    const huge = await preview(id, updateEmail("x".repeat(IMPORT_MAX_BODY_BYTES + 1)));
    expect(huge.status).toBe(413);
  });

  it("still refuses one value past the limit of a change, below the size of the body", async () => {
    const id = await unlocked();
    const long = await preview(id, updateEmail("x".repeat(1024 * 1024)));
    expect(long.status).toBe(400);
  });
});

describe("the request guard applies to every write route", () => {
  it("refuses a foreign Host and a foreign Origin", async () => {
    const id = await unlocked();
    const routes: Array<() => Promise<Response> | Response> = [
      () =>
        getStatus(
          new Request(at(id, "writes"), { headers: { host: "evil.example" } }),
          params({ id }),
        ),
      () =>
        unlock(
          json(
            at(id, "writes/unlock"),
            "POST",
            { database: "shop" },
            { origin: "http://evil.example" },
          ),
          params({ id }),
        ),
      () =>
        lock(
          json(at(id, "writes/lock"), "POST", {}, { origin: "http://evil.example" }),
          params({ id }),
        ),
      () =>
        editInfo(
          json(
            at(id, "writes/edit-info"),
            "POST",
            { schema: "public", table: "users" },
            { origin: "http://evil.example" },
          ),
          params({ id }),
        ),
      () =>
        previewChange(
          json(at(id, "writes/preview"), "POST", updateEmail("x"), {
            origin: "http://evil.example",
          }),
          params({ id }),
        ),
      () =>
        applyChange(
          json(
            at(id, "writes/apply"),
            "POST",
            { previewId: "p".repeat(22) },
            { origin: "http://evil.example" },
          ),
          params({ id }),
        ),
      () =>
        getHistory(
          new Request(at(id, "writes/history"), { headers: { host: "evil.example" } }),
          params({ id }),
        ),
      () =>
        getRole(new Request(at(id, "role"), { headers: { host: "evil.example" } }), params({ id })),
    ];
    for (const run of routes) {
      const result = await call(run());
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("forbidden");
    }
  });
});

describe("no value reaches a log or an unexpected error", () => {
  it("masks a database failure that carries a value", async () => {
    const id = await unlocked();
    const adapter = context.createdAdapters.at(-1)!;
    vi.spyOn(adapter, "applyChange").mockRejectedValueOnce(
      Object.assign(new Error(`Key (email)=(${SECRET}) already exists`), { code: "23505" }),
    );
    const planned = await preview(id, updateEmail(SECRET));
    const result = await apply(id, { previewId: planned.body.preview.previewId });
    expect(result.status).toBe(500);
    expect(result.body.error).toEqual({
      code: "unexpected",
      message: "An unexpected error occurred.",
    });
    expect(result.text).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    // The failure is in the history, as a code only.
    const entry = (await history(id)).body.history[0];
    expect(entry).toMatchObject({ outcome: "failed", errorCode: "unexpected" });
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  it("logs nothing on the happy path", async () => {
    const id = await unlocked();
    await apply(id, { previewId: (await preview(id, updateEmail(SECRET))).body.preview.previewId });
    expect(logged).toEqual([]);
  });
});

describe("GET /connections/:id/role", () => {
  it("answers the role and the warnings for both modes, never cached", async () => {
    const id = await connect();
    const result = await call(getRole(new Request(at(id, "role")), params({ id })));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body.role).toEqual(MOCK_ROLE);
    expect(result.body.warnings.read.map((w: Json) => w.code)).toEqual(["can_write", "can_create"]);
    expect(result.body.warnings.write).toEqual([]);
  });

  it("warns about a superuser in both modes", async () => {
    const id = await connect();
    const adapter = context.createdAdapters.at(-1) as MockDatabaseAdapter;
    vi.spyOn(adapter, "getRoleInfo").mockResolvedValueOnce({ ...MOCK_ROLE, superuser: true });
    const result = await call(getRole(new Request(at(id, "role")), params({ id })));
    expect(result.body.warnings.read.map((w: Json) => w.code)).toEqual(["superuser"]);
    expect(result.body.warnings.write.map((w: Json) => w.code)).toEqual(["superuser"]);
  });

  it("answers 404 for an unknown connection", async () => {
    const result = await call(
      getRole(
        new Request(at("missing-connection-id", "role")),
        params({ id: "missing-connection-id" }),
      ),
    );
    expect(result.status).toBe(404);
  });
});
