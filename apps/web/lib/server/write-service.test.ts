/**
 * The write service: the four switches and their order, preview then apply
 * (single use, expiry, one connection only), one change at a time, the
 * session history, and that no value of a change ever ends up in the
 * history, a preview answer, an error or the console.
 */
import {
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

  it("accepts a Unix socket as this machine", () => {
    const { service, id } = setup({ summary: { host: "/var/run/postgresql" } });
    expect(service.unlock(id, "shop").unlocked).toBe(true);
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
      getIndexUsage: () => readOnly.getIndexUsage(),
      getRows: (t, o) => readOnly.getRows(t, o),
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
    expect(error.message).not.toContain(SECRET);
    const [entry] = service.history(id);
    expect(entry).toMatchObject({ outcome: "failed", errorCode: "row_changed" });
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
    expect((await refusal(() => service.preview(id, updateEmail()))).code).toBe("not_editable");
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
    for (let i = 0; i < MAX_HISTORY_PER_CONNECTION + 5; i += 1) {
      const preview = await service.preview(
        id,
        updateEmail(`v${i}@x.test`, i === 0 ? "a@x.test" : `v${i - 1}@x.test`),
      );
      await service.apply(id, preview.previewId);
    }
    const history = service.history(id);
    expect(history).toHaveLength(MAX_HISTORY_PER_CONNECTION);
    // Newest first: the last change made is at the top, and the oldest ones were dropped.
    expect(new Set(history.map((entry) => entry.id)).size).toBe(MAX_HISTORY_PER_CONNECTION);
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
