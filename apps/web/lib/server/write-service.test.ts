/**
 * The write service: the four switches and their order, preview then apply
 * (single use, expiry, one connection only), one change at a time, the
 * session history, and that no value of a change ever ends up in the
 * history, a preview answer, an error or the console.
 */
import {
  DEFAULT_ERROR_MESSAGES,
  DatabaseError,
  PREVIEW_TTL_MS,
  type AppliedChange,
  type Change,
  type PlannedChange,
} from "@datacanvas/database-core";
import { MockDatabaseAdapter } from "@datacanvas/database-core/testing";
import type { ConnectionSummary } from "@datacanvas/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionRegistry } from "./connection-registry";
import { PreviewStore } from "./preview-store";
import { MAX_HISTORY_PER_CONNECTION, WRITE_MESSAGES, WriteService } from "./write-service";

const details: Omit<ConnectionSummary, "id"> = {
  provider: "postgresql",
  name: "Shop",
  host: "localhost",
  port: 5432,
  database: "shop",
  username: "alice",
  sslMode: "disable",
  hasPassword: true,
  dataAccess: true,
  profileId: null,
};

/** A value that must never appear outside the database. */
const SECRET = "zz-distinctive-value-9f3a";

const users = { schema: "public", name: "users" };
const readUsers = (adapter: MockDatabaseAdapter) =>
  adapter.getRows(users, { pageSize: 10, cursor: null, revealColumns: [] });
const updateEmail = (value: string | null = SECRET, seen: string | null = "a@x.test"): Change => ({
  kind: "update_row",
  table: users,
  key: [{ column: "id", value: "1" }],
  set: [{ column: "email", value }],
  expected: [{ column: "email", value: seen }],
});

let logged: unknown[][];
beforeEach(() => {
  logged = [];
  for (const method of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
});
afterEach(() => vi.restoreAllMocks());

function setup(
  options: {
    writesEnabled?: boolean;
    summary?: Partial<Omit<ConnectionSummary, "id">>;
    adapter?: MockDatabaseAdapter;
  } = {},
) {
  let clock = 1_700_000_000_000;
  const registry = new ConnectionRegistry();
  const adapter = options.adapter ?? new MockDatabaseAdapter();
  const service = new WriteService({
    connections: registry,
    writesEnabled: options.writesEnabled ?? true,
    now: () => clock,
  });
  const { id } = registry.add({ ...details, ...options.summary }, adapter);
  return { registry, service, adapter, id, advance: (ms: number) => void (clock += ms) };
}

async function refusal(work: () => unknown): Promise<{ code: string; message: string }> {
  try {
    await work();
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

describe("WriteService: the switches", () => {
  it("reports the four switches", () => {
    const { service, id } = setup();
    expect(service.status(id)).toEqual({
      enabled: true,
      local: true,
      dataAccess: true,
      unlocked: false,
    });
  });

  it("refuses to unlock without --enable-writes, first of all", async () => {
    const { service, id } = setup({
      writesEnabled: false,
      summary: { host: "db.example.com", dataAccess: false },
    });
    const error = await refusal(() => service.unlock(id, "shop"));
    expect(error.code).toBe("writes_not_enabled");
    expect(error.message).toContain("--enable-writes");
  });

  it("then refuses a database that is not on this machine", async () => {
    const { service, id } = setup({ summary: { host: "db.example.com", dataAccess: false } });
    const error = await refusal(() => service.unlock(id, "shop"));
    expect(error).toMatchObject({
      code: "writes_not_allowed_here",
      message: WRITE_MESSAGES.notLocal,
    });
    expect(service.status(id).local).toBe(false);
  });

  it("then refuses while data viewing is off", async () => {
    const { service, id } = setup({ summary: { dataAccess: false } });
    expect((await refusal(() => service.unlock(id, "shop"))).code).toBe("data_access_disabled");
  });

  it("then refuses a wrong name without repeating it", async () => {
    const { service, id } = setup();
    for (const typed of [SECRET, "SHOP", " shop", "shop "]) {
      const error = await refusal(() => service.unlock(id, typed));
      expect(error.code).toBe("wrong_database_name");
      expect(error.message).not.toContain(typed.trim() || "x");
    }
    expect(service.status(id).unlocked).toBe(false);
  });

  it("unlocks with the exact name and locks again", () => {
    const { service, id } = setup();
    expect(service.unlock(id, "shop").unlocked).toBe(true);
    expect(service.lock(id).unlocked).toBe(false);
  });

  it("refuses everything for an unknown connection", async () => {
    const { service } = setup();
    for (const work of [
      () => service.status("missing"),
      () => service.unlock("missing", "shop"),
      () => service.lock("missing"),
      () => service.preview("missing", updateEmail()),
      () => service.apply("missing", "p".repeat(22)),
      () => service.history("missing"),
    ]) {
      expect((await refusal(work)).code).toBe("connection_not_found");
    }
  });

  it("refuses edit info, preview and apply while locked", async () => {
    const { service, id } = setup();
    expect((await refusal(() => service.editInfo(id, users))).code).toBe("write_not_unlocked");
    expect((await refusal(() => service.preview(id, updateEmail()))).code).toBe(
      "write_not_unlocked",
    );
    expect((await refusal(() => service.apply(id, "p".repeat(22)))).code).toBe(
      "write_not_unlocked",
    );
  });

  it("checks every switch again on every call", async () => {
    const { service, registry, id } = setup();
    service.unlock(id, "shop");
    registry.setDataAccess(id, false);
    // Switching data viewing off locks writes too.
    expect(service.status(id)).toMatchObject({ dataAccess: false, unlocked: false });
    expect((await refusal(() => service.preview(id, updateEmail()))).code).toBe(
      "data_access_disabled",
    );
  });

  it("refuses an adapter without the write capability", async () => {
    const registry = new ConnectionRegistry();
    const readOnly = new MockDatabaseAdapter();
    // A read-only adapter: the same object without the write methods.
    const { id } = registry.add(details, {
      connect: () => readOnly.connect(),
      testConnection: () => readOnly.testConnection(),
      getSchemas: () => readOnly.getSchemas(),
      getTables: (s) => readOnly.getTables(s),
      getColumns: (s, t) => readOnly.getColumns(s, t),
      getConstraints: (s, t) => readOnly.getConstraints(s, t),
      getIndexes: (s, t) => readOnly.getIndexes(s, t),
      getTablesDetails: (t) => readOnly.getTablesDetails(t),
      searchObjects: (q, l) => readOnly.searchObjects(q, l),
      getRelationships: () => readOnly.getRelationships(),
      getObjects: () => readOnly.getObjects(),
      getDdlDetail: (t, s) => readOnly.getDdlDetail(t, s),
      getIndexUsage: () => readOnly.getIndexUsage(),
      getTableStatistics: (t) => readOnly.getTableStatistics(t),
      getSizes: (o) => readOnly.getSizes(o),
      getRows: (t, o) => readOnly.getRows(t, o),
      getCell: (t, r) => readOnly.getCell(t, r),
      validateRows: (r) => readOnly.validateRows(r),
      preflight: (c) => readOnly.preflight(c),
      exportRows: (t, o, s, g) => readOnly.exportRows(t, o, s, g),
      getRoleInfo: () => readOnly.getRoleInfo(),
      disconnect: () => readOnly.disconnect(),
    });
    const service = new WriteService({ connections: registry, writesEnabled: true });
    service.unlock(id, "shop");
    expect((await refusal(() => service.preview(id, updateEmail()))).code).toBe("not_supported");
  });
});

describe("WriteService: preview and apply", () => {
  it("previews without sending the values back, and changes nothing", async () => {
    const { service, adapter, id } = setup();
    service.unlock(id, "shop");
    const preview = await service.preview(id, updateEmail());
    expect(preview.previewId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(preview.statement).toContain('UPDATE "public"."users"');
    expect(preview.statement).toContain("$1");
    expect(preview.category).toBe("row");
    expect(preview.destructive).toBe(false);
    expect(new Date(preview.expiresAt).getTime()).toBe(1_700_000_000_000 + PREVIEW_TTL_MS);
    expect(JSON.stringify(preview)).not.toContain(SECRET);
    const page = await readUsers(adapter);
    expect(JSON.stringify(page)).not.toContain(SECRET);
  });

  it("applies exactly the preview, once", async () => {
    const { service, adapter, id } = setup();
    service.unlock(id, "shop");
    const { previewId } = await service.preview(id, updateEmail("new@x.test"));
    const result = await service.apply(id, previewId);
    expect(result.rowCount).toBe(1);
    expect(result.entry).toMatchObject({
      kind: "update_row",
      table: users,
      columns: ["email"],
      statement: null,
      outcome: "applied",
      errorCode: null,
    });
    const page = await readUsers(adapter);
    expect(page.rows[0]?.[1]?.value).toBe("new@x.test");
    expect((await refusal(() => service.apply(id, previewId))).code).toBe("preview_expired");
  });

  it("refuses an expired preview", async () => {
    const { service, id, advance } = setup();
    service.unlock(id, "shop");
    const { previewId } = await service.preview(id, updateEmail());
    advance(PREVIEW_TTL_MS + 1);
    const error = await refusal(() => service.apply(id, previewId));
    expect(error).toMatchObject({
      code: "preview_expired",
      message: WRITE_MESSAGES.previewExpired,
    });
  });

  it("refuses a preview of another connection", async () => {
    const { service, registry, id } = setup();
    const other = registry.add(details, new MockDatabaseAdapter()).id;
    service.unlock(id, "shop");
    service.unlock(other, "shop");
    const { previewId } = await service.preview(id, updateEmail());
    expect((await refusal(() => service.apply(other, previewId))).code).toBe("preview_expired");
    expect((await service.apply(id, previewId)).rowCount).toBe(1);
  });

  it("drops the previews when writes are locked, or unlocked again", async () => {
    const { service, id } = setup();
    service.unlock(id, "shop");
    const first = await service.preview(id, updateEmail());
    service.lock(id);
    service.unlock(id, "shop");
    expect((await refusal(() => service.apply(id, first.previewId))).code).toBe("preview_expired");
    const second = await service.preview(id, updateEmail());
    service.unlock(id, "shop");
    expect((await refusal(() => service.apply(id, second.previewId))).code).toBe("preview_expired");
  });

  it("runs one change at a time per connection, without using up the waiting preview", async () => {
    const adapter = new MockDatabaseAdapter();
    let release: () => void = () => {};
    const original = adapter.applyChange.bind(adapter);
    vi.spyOn(adapter, "applyChange").mockImplementationOnce(
      (plan: PlannedChange) =>
        new Promise<AppliedChange>((resolve, reject) => {
          release = () => void original(plan).then(resolve, reject);
        }),
    );
    const { service, id } = setup({ adapter });
    service.unlock(id, "shop");
    const a = await service.preview(id, updateEmail("one@x.test"));
    const b = await service.preview(id, updateEmail("two@x.test", "one@x.test"));
    const running = service.apply(id, a.previewId);
    await Promise.resolve();
    expect((await refusal(() => service.apply(id, b.previewId))).code).toBe("write_busy");
    release();
    expect((await running).rowCount).toBe(1);
    expect((await service.apply(id, b.previewId)).rowCount).toBe(1);
  });

  it("records a failure with its code and no value, and frees the connection", async () => {
    const { service, id } = setup();
    service.unlock(id, "shop");
    // The person saw something else: the row "changed since it was loaded".
    const { previewId } = await service.preview(id, updateEmail(SECRET, "not-what-is-there"));
    const error = await refusal(() => service.apply(id, previewId));
    expect(error.code).toBe("row_changed");
    // Neither the new value, nor the value the person saw, nor what is really there is in the error.
    for (const supplied of [SECRET, "not-what-is-there", "a@x.test"]) {
      expect(error.message).not.toContain(supplied);
    }
    const [entry] = service.history(id);
    expect(entry).toMatchObject({ outcome: "failed", errorCode: "row_changed" });
    for (const supplied of [SECRET, "not-what-is-there"]) {
      expect(JSON.stringify(entry)).not.toContain(supplied);
    }
    const next = await service.preview(id, updateEmail("ok@x.test"));
    expect((await service.apply(id, next.previewId)).rowCount).toBe(1);
  });

  it("requires the table's name typed for a drop", async () => {
    const { service, id } = setup();
    service.unlock(id, "shop");
    const error = await refusal(() =>
      service.preview(id, { kind: "drop_table", table: users, confirm: "user" }),
    );
    expect(error).toMatchObject({ code: "invalid_change", message: WRITE_MESSAGES.confirmName });
    const column = await refusal(() =>
      service.preview(id, { kind: "drop_column", table: users, column: "full_name", confirm: "" }),
    );
    expect(column.code).toBe("invalid_change");
  });

  it("keeps the SQL of a change of structure in the history", async () => {
    const { service, id } = setup();
    service.unlock(id, "shop");
    const { previewId } = await service.preview(id, {
      kind: "rename_column",
      table: users,
      column: "full_name",
      to: "display_name",
    });
    const { entry } = await service.apply(id, previewId);
    expect(entry).toMatchObject({ kind: "rename_column", outcome: "applied" });
    expect(entry.statement).toContain('RENAME COLUMN "full_name" TO "display_name"');
    expect(entry.columns).toEqual(["full_name", "display_name"]);
  });

  it("passes database errors through unchanged (they carry fixed messages)", async () => {
    const adapter = new MockDatabaseAdapter();
    vi.spyOn(adapter, "previewChange").mockRejectedValueOnce(new DatabaseError("not_editable"));
    const { service, id } = setup({ adapter });
    service.unlock(id, "shop");
    const error = await refusal(() => service.preview(id, updateEmail()));
    expect(error.code).toBe("not_editable");
    // The adapter's fixed sentence arrives as it is, not rewritten and not extended.
    expect(error.message).toBe(DEFAULT_ERROR_MESSAGES.not_editable);
  });
});

describe("WriteService: the migration file", () => {
  const rename: Change = {
    kind: "rename_column",
    table: users,
    column: "full_name",
    to: "display_name",
  };

  it("holds the structure changes that were applied, in order, as one script", async () => {
    const { service, id } = setup();
    service.unlock(id, "shop");
    const first = await service.preview(id, rename);
    await service.apply(id, first.previewId);
    const second = await service.preview(id, {
      kind: "rename_column",
      table: users,
      column: "email",
      to: "mail",
    });
    await service.apply(id, second.previewId);
    const migration = service.migration(id);
    expect(migration).toMatchObject({
      steps: 2,
      rowChanges: 0,
      omittedSteps: 0,
      filename: "datacanvas-shop-2023-11-14.sql",
    });
    // In the order they ran.
    expect(migration.script.indexOf('TO "display_name"')).toBeLessThan(
      migration.script.indexOf('TO "mail"'),
    );
    expect(migration.script).toContain("BEGIN;");
    expect(migration.script).toContain('RENAME COLUMN "full_name" TO "display_name"');
    expect(migration.script.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("counts row changes and never writes their values", async () => {
    const { service, id } = setup();
    service.unlock(id, "shop");
    const planned = await service.preview(id, updateEmail());
    await service.apply(id, planned.previewId);
    const migration = service.migration(id);
    expect(migration).toMatchObject({ steps: 0, rowChanges: 1 });
    expect(migration.script).not.toContain(SECRET);
    expect(JSON.stringify(migration)).not.toContain(SECRET);
  });

  it("leaves out a change that failed, and needs no unlock to be read", async () => {
    const adapter = new MockDatabaseAdapter();
    const { service, id } = setup({ adapter });
    service.unlock(id, "shop");
    const planned = await service.preview(id, rename);
    vi.spyOn(adapter, "applyChange").mockRejectedValueOnce(new DatabaseError("not_editable"));
    await refusal(() => service.apply(id, planned.previewId));
    service.lock(id);
    expect(service.migration(id)).toMatchObject({ steps: 0, rowChanges: 0 });
  });

  it("is forgotten with the connection and refused for an unknown one", async () => {
    const { service, registry, id } = setup();
    service.unlock(id, "shop");
    const planned = await service.preview(id, rename);
    await service.apply(id, planned.previewId);
    registry.remove(id);
    expect((await refusal(() => service.migration(id))).code).toBe("connection_not_found");
  });

  it("keeps the migration out of the history", async () => {
    const { service, id } = setup();
    service.unlock(id, "shop");
    const planned = await service.preview(id, rename);
    await service.apply(id, planned.previewId);
    expect(service.history(id)[0]).not.toHaveProperty("sql");
  });
});

describe("WriteService: locking while a write is on its way", () => {
  it("does not apply when writes are locked while the connection is reconnecting", async () => {
    const adapter = new MockDatabaseAdapter();
    const { service, registry, id } = setup({ adapter });
    service.unlock(id, "shop");
    const { previewId } = await service.preview(id, updateEmail("late@x.test"));

    // The connection was closed as idle: the next use has to reconnect, and waits for it.
    let finishReconnect: () => void = () => {};
    vi.spyOn(adapter, "connect").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishReconnect = resolve;
        }),
    );
    const applySpy = vi.spyOn(adapter, "applyChange");
    const applying = refusal(() => service.apply(id, previewId));
    await Promise.resolve();

    // The person locks writes (or switches data viewing off) while it waits.
    expect(registry.isWriteUnlocked(id)).toBe(true);
    service.lock(id);
    finishReconnect();

    expect((await applying).code).toBe("write_not_unlocked");
    expect(applySpy).not.toHaveBeenCalled();
    const [entry] = service.history(id);
    expect(entry).toMatchObject({ outcome: "failed", errorCode: "write_not_unlocked" });
    const page = await readUsers(adapter);
    expect(page.rows[0]?.[1]?.value).toBe("a@x.test");
  });

  it("drops the previews at once when data viewing is switched off", async () => {
    const clock = 1_700_000_000_000;
    const previews = new PreviewStore({ now: () => clock });
    const registry = new ConnectionRegistry();
    const service = new WriteService({
      connections: registry,
      writesEnabled: true,
      previews,
      now: () => clock,
    });
    const { id } = registry.add(details, new MockDatabaseAdapter());
    service.unlock(id, "shop");
    const { previewId } = await service.preview(id, updateEmail(SECRET));
    expect(previews.count(id)).toBe(1);

    registry.setDataAccess(id, false);
    // Gone now, not when the store is next used: it held the person's values.
    expect(previews.heldCount()).toBe(0);

    registry.setDataAccess(id, true);
    service.unlock(id, "shop");
    expect((await refusal(() => service.apply(id, previewId))).code).toBe("preview_expired");
    previews.dispose();
  });

  it("does not touch another connection's previews", async () => {
    const previews = new PreviewStore();
    const registry = new ConnectionRegistry();
    const service = new WriteService({ connections: registry, writesEnabled: true, previews });
    const a = registry.add(details, new MockDatabaseAdapter()).id;
    const b = registry.add(details, new MockDatabaseAdapter()).id;
    service.unlock(a, "shop");
    service.unlock(b, "shop");
    await service.preview(a, updateEmail());
    await service.preview(b, updateEmail());
    registry.setDataAccess(a, false);
    expect(previews.count(a)).toBe(0);
    expect(previews.count(b)).toBe(1);
    previews.dispose();
  });
});

describe("WriteService: history and privacy", () => {
  it("never holds a value, applied or failed, and never logs", async () => {
    const { service, id } = setup();
    service.unlock(id, "shop");
    const insert: Change = {
      kind: "insert_row",
      table: users,
      values: [
        { column: "email", value: SECRET },
        { column: "full_name", value: `${SECRET}-name` },
      ],
    };
    const applied = await service.apply(id, (await service.preview(id, insert)).previewId);
    const duplicate = await service.preview(id, insert);
    await refusal(() => service.apply(id, duplicate.previewId)); // unique_violation
    const history = service.history(id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ outcome: "failed", errorCode: "unique_violation" });
    expect(history[1]).toEqual(applied.entry);
    expect(JSON.stringify(history)).not.toContain(SECRET);
    expect(history.every((entry) => !("value" in entry) && !("values" in entry))).toBe(true);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(logged).toEqual([]);
  });

  it("keeps a bounded history, newest first", async () => {
    const { service, id } = setup();
    service.unlock(id, "shop");
    const total = MAX_HISTORY_PER_CONNECTION + 5;
    const applied: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const preview = await service.preview(
        id,
        updateEmail(`v${i}@x.test`, i === 0 ? "a@x.test" : `v${i - 1}@x.test`),
      );
      applied.push((await service.apply(id, preview.previewId)).entry.id);
    }
    const history = service.history(id);
    expect(history).toHaveLength(MAX_HISTORY_PER_CONNECTION);
    // Newest first: the last change made is at the top, the oldest kept one at the bottom,
    // and the first five were evicted.
    expect(history.map((entry) => entry.id)).toEqual(applied.slice(5).reverse());
    expect(history.some((entry) => applied.slice(0, 5).includes(entry.id))).toBe(false);
  });

  it("keeps no SQL for a change of structure that carries text the person typed", async () => {
    const { service, id } = setup();
    service.unlock(id, "shop");
    const typed = [
      // A literal default, and a comment.
      {
        kind: "set_default",
        table: users,
        column: "full_name",
        default: { kind: "literal", value: `${SECRET}-default` },
      },
      {
        kind: "add_column",
        table: users,
        column: {
          name: "note",
          type: { name: "text" },
          nullable: true,
          default: { kind: "none" },
          identity: null,
          comment: `${SECRET}-comment`,
        },
      },
    ] satisfies Change[];
    for (const change of typed) {
      const preview = await service.preview(id, change);
      // The preview is what the person typed and must see, exactly.
      expect(preview.statement).toContain(change.kind === "set_default" ? SECRET : "note");
      const { entry } = await service.apply(id, preview.previewId);
      expect(entry.statement).toBeNull();
      expect(entry).toMatchObject({ kind: change.kind, outcome: "applied" });
    }
    expect(JSON.stringify(service.history(id))).not.toContain(SECRET);

    // A change without such text keeps its SQL, as before.
    const plain = await service.preview(id, {
      kind: "set_default",
      table: users,
      column: "created_at",
      default: { kind: "now" },
    });
    const { entry } = await service.apply(id, plain.previewId);
    expect(entry.statement).toContain("SET DEFAULT now()");
  });

  it("forgets the previews and the history when the connection is closed", async () => {
    const { service, registry, id } = setup();
    service.unlock(id, "shop");
    const kept = await service.preview(id, updateEmail());
    await service.apply(id, (await service.preview(id, updateEmail("x@x.test"))).previewId);
    expect(service.history(id)).toHaveLength(1);
    await registry.remove(id);
    // A new connection to the same database starts locked, with no history.
    const again = registry.add(details, new MockDatabaseAdapter()).id;
    expect(service.status(again).unlocked).toBe(false);
    expect(service.history(again)).toEqual([]);
    service.unlock(again, "shop");
    expect((await refusal(() => service.apply(again, kept.previewId))).code).toBe(
      "preview_expired",
    );
  });
});
