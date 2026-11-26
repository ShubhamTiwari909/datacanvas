import { describe, expect, it } from "vitest";
import { isWritableAdapter } from "../adapter.js";
import {
  DESTRUCTIVE_CHANGE_KINDS,
  MATCHING_CHANGE_KINDS,
  ROW_CHANGE_KINDS,
  changeColumns,
  type Change,
} from "../changes.js";
import type { DatabaseError } from "../errors.js";
import { MockDatabaseAdapter } from "./mock-adapter.js";
import { createEcommerceData } from "./ecommerce-fixture.js";

const users = { schema: "public", name: "users" };

async function setup() {
  const adapter = new MockDatabaseAdapter();
  await adapter.connect();
  const run = async (change: Change) => adapter.applyChange(await adapter.previewChange(change));
  const emails = async () =>
    (await adapter.getRows(users, { pageSize: 50, cursor: null, revealColumns: [] })).rows.map(
      (row) => row[1]?.value,
    );
  return { adapter, run, emails };
}

const update = (value: string | null, seen: string | null = "a@x.test"): Change => ({
  kind: "update_row",
  table: users,
  key: [{ column: "id", value: "1" }],
  set: [{ column: "email", value }],
  expected: [{ column: "email", value: seen }],
});

describe("the mock adapter's write side", () => {
  it("is a WritableAdapter, and reads need a connection", async () => {
    const adapter = new MockDatabaseAdapter();
    expect(isWritableAdapter(adapter)).toBe(true);
    await expect(adapter.describeForEdit(users)).rejects.toMatchObject({ code: "not_connected" });
  });

  it("describes an editable table by its primary key, with its triggers and incoming keys", async () => {
    const { adapter } = await setup();
    const info = await adapter.describeForEdit(users);
    expect(info).toMatchObject({ editable: true, reason: null, key: ["id"] });
    expect(info.columns.find((c) => c.name === "id")).toMatchObject({ inKey: true });
    expect(info.incomingForeignKeys[0]?.from.table).toBe("orders");
    const orders = await adapter.describeForEdit({ schema: "public", name: "orders" });
    expect(orders.triggers).toEqual(["orders_touch"]);
    expect(orders.rowSecurity).toBe(true);
  });

  it("lists the keys an import by key may use, and refuses an import by key (the real adapter does it)", async () => {
    const { adapter } = await setup();
    const info = await adapter.describeForEdit(users);
    expect(info.uniqueKeys).toEqual([
      { name: "users_pkey", columns: ["id"] },
      { name: "users_email_key", columns: ["email"] },
    ]);
    const rows = [["1", "a@x.test"]];
    for (const change of [
      {
        kind: "upsert_rows",
        table: users,
        key: ["id"],
        columns: ["id", "email"],
        rows,
        updateColumns: [],
      },
      { kind: "update_by_key", table: users, key: ["id"], columns: ["id", "email"], rows },
    ] satisfies Change[]) {
      await expect(adapter.previewChange(change)).rejects.toMatchObject({
        code: "invalid_change",
      });
    }
  });

  it("refuses a change of the rows a filter matches (the real adapter does it), and names its columns for the history", async () => {
    const { adapter, emails } = await setup();
    const before = await emails();
    const filters = [{ column: "email", op: "contains" as const, value: "x.test" }];
    const updating: Change = {
      kind: "update_matching",
      table: users,
      filters,
      revealColumns: [],
      set: { column: "full_name", value: "n" },
    };
    const deleting: Change = { kind: "delete_matching", table: users, filters, revealColumns: [] };
    const changes = [updating, deleting];
    for (const change of changes) {
      await expect(adapter.previewChange(change)).rejects.toMatchObject({
        code: "invalid_change",
        message: "The sample database changes one row at a time.",
      });
    }
    expect(await emails()).toEqual(before);
    expect(changeColumns(updating)).toEqual(["full_name"]);
    expect(
      changeColumns({
        kind: "delete_matching",
        table: users,
        filters: [...filters, { column: "id", op: "gt", value: "1" }, ...filters],
        revealColumns: [],
      }),
    ).toEqual(["email", "id"]);
    for (const kind of ["update_matching", "delete_matching"] as const) {
      expect(DESTRUCTIVE_CHANGE_KINDS).toContain(kind);
      expect(MATCHING_CHANGE_KINDS).toContain(kind);
      expect(ROW_CHANGE_KINDS).toContain(kind);
    }
  });

  it("refuses a table that does not exist and a view", async () => {
    const { adapter } = await setup();
    await expect(adapter.describeForEdit({ schema: "public", name: "nope" })).rejects.toMatchObject(
      { code: "not_found" },
    );
    const views = (await adapter.getTables("public")).filter((t) => t.kind === "view");
    if (views[0]) {
      const info = await adapter.describeForEdit({ schema: views[0].schema, name: views[0].name });
      expect(info).toMatchObject({ editable: false, reason: "not_a_table" });
    }
  });

  it("plans an update with quoted names and every value as a parameter", async () => {
    const { adapter } = await setup();
    const plan = await adapter.previewChange(update('x"; DROP TABLE users; --'));
    const [statement] = plan.statements;
    expect(statement?.text).toContain('UPDATE "public"."users" SET "email" = CAST($1 AS text)');
    expect(statement?.text).not.toContain("DROP TABLE");
    expect(statement?.values).toEqual(['x"; DROP TABLE users; --', "1", "a@x.test"]);
    expect(plan).toMatchObject({ expect: "one_row", category: "row", destructive: false });
  });

  it("changes nothing when only previewed", async () => {
    const { adapter, emails } = await setup();
    await adapter.previewChange(update("new@x.test"));
    expect(await emails()).toEqual(["a@x.test", "b@x.test", "c@x.test"]);
  });

  it("updates one row, and refuses when the row is no longer what the person saw", async () => {
    const { run, emails } = await setup();
    expect((await run(update("new@x.test"))).rowCount).toBe(1);
    expect(await emails()).toEqual(["new@x.test", "b@x.test", "c@x.test"]);
    await expect(run(update("other@x.test"))).rejects.toMatchObject({ code: "row_changed" });
    expect(await emails()).toEqual(["new@x.test", "b@x.test", "c@x.test"]);
  });

  it("tells NULL from the empty string in the conflict check", async () => {
    const { adapter, run } = await setup();
    await run({
      kind: "update_row",
      table: users,
      key: [{ column: "id", value: "1" }],
      set: [{ column: "full_name", value: "" }],
      expected: [{ column: "full_name", value: null }],
    });
    const page = await adapter.getRows(users, { pageSize: 5, cursor: null, revealColumns: [] });
    expect(page.rows[0]?.[2]).toEqual({ value: "", truncated: false });
    await expect(
      run({
        kind: "update_row",
        table: users,
        key: [{ column: "id", value: "1" }],
        set: [{ column: "full_name", value: "x" }],
        expected: [{ column: "full_name", value: null }],
      }),
    ).rejects.toMatchObject({ code: "row_changed" });
  });

  it("enforces unique and NOT NULL with fixed messages that hold no value", async () => {
    const { run } = await setup();
    const unique = await run(update("b@x.test")).catch((e: unknown) => e as DatabaseError);
    expect(unique).toMatchObject({ code: "unique_violation" });
    expect((unique as DatabaseError).message).not.toContain("b@x.test");
    await expect(run(update(null))).rejects.toMatchObject({ code: "not_null_violation" });
  });

  it("inserts with a generated id and defaults, and refuses a non-numeric id", async () => {
    const { adapter, run, emails } = await setup();
    await run({
      kind: "insert_row",
      table: users,
      values: [{ column: "email", value: "d@x.test" }],
    });
    expect(await emails()).toEqual(["a@x.test", "b@x.test", "c@x.test", "d@x.test"]);
    const page = await adapter.getRows(users, { pageSize: 10, cursor: null, revealColumns: [] });
    expect(page.rows[3]?.[0]?.value).toBe("4");
    // The column left out gets its default (created_at defaults to now()), not NULL.
    const created = page.columns.findIndex((c) => c.name === "created_at");
    expect(created).toBeGreaterThan(-1);
    expect(page.rows[3]?.[created]?.value).toBe("2026-11-16 12:00:00+00");
    await expect(
      adapter.previewChange({
        kind: "update_row",
        table: users,
        key: [{ column: "id", value: "not-a-number" }],
        set: [{ column: "email", value: "x" }],
        expected: [{ column: "email", value: "y" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_value" });
  });

  it("deletes one row, and not one that is already gone", async () => {
    const { run, emails } = await setup();
    const remove: Change = {
      kind: "delete_row",
      table: users,
      key: [{ column: "id", value: "2" }],
    };
    expect((await run(remove)).rowCount).toBe(1);
    expect(await emails()).toEqual(["a@x.test", "c@x.test"]);
    await expect(run(remove)).rejects.toMatchObject({ code: "row_changed" });
  });

  it("needs the whole key, and only the key", async () => {
    const { adapter } = await setup();
    await expect(
      adapter.previewChange({
        kind: "delete_row",
        table: users,
        key: [{ column: "email", value: "a@x.test" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_change" });
  });

  it("creates and drops a table, and refuses a name that exists or has dependents", async () => {
    const { adapter, run } = await setup();
    const create: Change = {
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
      ],
      primaryKey: ["id"],
      unique: [],
      foreignKeys: [],
      comment: null,
    };
    const plan = await adapter.previewChange(create);
    expect(plan.statements[0]?.text).toContain(
      '"id" integer GENERATED ALWAYS AS IDENTITY NOT NULL',
    );
    await adapter.applyChange(plan);
    expect((await adapter.getTables("public")).map((t) => t.name)).toContain("tags");
    await expect(adapter.previewChange(create)).rejects.toMatchObject({ code: "already_exists" });
    await run({ kind: "drop_table", table: { schema: "public", name: "tags" }, confirm: "tags" });
    expect((await adapter.getTables("public")).map((t) => t.name)).not.toContain("tags");
    await expect(
      adapter.previewChange({ kind: "drop_table", table: users, confirm: "users" }),
    ).rejects.toMatchObject({ code: "has_dependents" });
  });

  it("records other structure changes without changing the sample data", async () => {
    const { adapter, run } = await setup();
    await run({ kind: "rename_table", table: users, to: "people" });
    expect(adapter.appliedStructureChanges).toHaveLength(1);
    expect((await adapter.getTables("public")).map((t) => t.name)).toContain("users");
  });

  it("flags a destructive change in its plan", async () => {
    const { adapter } = await setup();
    const plan = await adapter.previewChange({
      kind: "drop_column",
      table: users,
      column: "full_name",
      confirm: "users",
    });
    expect(plan.destructive).toBe(true);
    expect(plan.warnings.map((w) => w.code)).toContain("destructive");
  });

  it("does not let a caller change its state through a returned plan", async () => {
    const { adapter, emails } = await setup();
    const plan = await adapter.previewChange(update("new@x.test"));
    plan.statements.length = 0;
    // A fresh plan is unaffected by what was done to the first one.
    const fresh = await adapter.previewChange(update("new@x.test"));
    expect(fresh.statements).toHaveLength(1);
    await adapter.applyChange(fresh);
    expect(await emails()).toEqual(["new@x.test", "b@x.test", "c@x.test"]);
  });
  it("previews a literal default with the column's own type, not text", async () => {
    const { adapter } = await setup();
    const plan = await adapter.previewChange({
      kind: "set_default",
      table: { schema: "public", name: "order_items" },
      column: "quantity",
      default: { kind: "literal", value: "7" },
    });
    expect(plan.statements[0]?.text).toContain("SET DEFAULT CAST('7' AS integer)");
  });

  it("puts the chosen ON DELETE and ON UPDATE in a foreign key statement", async () => {
    const { adapter } = await setup();
    const fk = {
      columns: ["user_id"],
      references: { schema: "public", table: "users", columns: ["id"] },
      onDelete: "cascade" as const,
      onUpdate: "set_null" as const,
    };
    const added = await adapter.previewChange({
      kind: "add_foreign_key",
      table: { schema: "public", name: "orders" },
      foreignKey: fk,
    });
    expect(added.statements[0]?.text).toContain("ON DELETE CASCADE ON UPDATE SET NULL");
    const created = await adapter.previewChange({
      kind: "create_table",
      schema: "public",
      name: "audit",
      columns: [
        {
          name: "user_id",
          type: { name: "integer" },
          nullable: true,
          default: { kind: "none" },
          identity: null,
          comment: null,
        },
      ],
      primaryKey: [],
      unique: [],
      foreignKeys: [fk],
      comment: null,
    });
    expect(created.statements[0]?.text).toContain("ON DELETE CASCADE ON UPDATE SET NULL");
  });

  it("removes a dropped table's foreign keys from the catalog", async () => {
    const { adapter, run } = await setup();
    const touching = (rels: Awaited<ReturnType<typeof adapter.getRelationships>>) =>
      rels.filter((r) => r.source.table === "order_items" || r.target.table === "order_items");
    expect(touching(await adapter.getRelationships()).length).toBeGreaterThan(0);
    await run({
      kind: "drop_table",
      table: { schema: "public", name: "order_items" },
      confirm: "order_items",
    });
    expect(touching(await adapter.getRelationships())).toEqual([]);
  });

  it("does not write into a fixture it was given, nor into another adapter using it", async () => {
    const data = createEcommerceData();
    const before = JSON.stringify(data);
    const a = new MockDatabaseAdapter({ data });
    const b = new MockDatabaseAdapter({ data });
    await a.connect();
    await b.connect();
    await a.applyChange(await a.previewChange(update("changed@x.test")));
    const emailsOf = async (adapter: MockDatabaseAdapter) =>
      (await adapter.getRows(users, { pageSize: 10, cursor: null, revealColumns: [] })).rows.map(
        (row) => row[1]?.value,
      );
    expect((await emailsOf(a))[0]).toBe("changed@x.test");
    expect((await emailsOf(b))[0]).toBe("a@x.test");
    expect(JSON.stringify(data)).toBe(before);
  });

  it("keeps defaults, identity and unique keys of a table it creates", async () => {
    const { adapter, run } = await setup();
    const col = (
      name: string,
      type: "integer" | "text",
      extra: Partial<Parameters<typeof run>[0] & object> & Record<string, unknown> = {},
    ) => ({
      name,
      type: { name: type },
      nullable: true,
      default: { kind: "none" as const },
      identity: null,
      comment: null,
      ...extra,
    });
    await run({
      kind: "create_table",
      schema: "public",
      name: "made",
      columns: [
        col("id", "integer", { identity: "always", nullable: false }),
        col("code", "text"),
        col("label", "text", { default: { kind: "literal", value: "it's new" } }),
        col("qty", "integer", { default: { kind: "literal", value: "3" } }),
      ],
      primaryKey: ["id"],
      unique: [["code"]],
      foreignKeys: [],
      comment: null,
    });
    const made = { schema: "public", name: "made" };
    const info = await adapter.describeForEdit(made);
    expect(info.key).toEqual(["id"]);
    // An identity ALWAYS column is filled by the database: not editable, but it has a default.
    expect(info.columns.find((c) => c.name === "id")).toMatchObject({
      identity: "always",
      generated: true,
      editable: false,
      hasDefault: true,
      nullable: false,
    });
    expect(info.columns.find((c) => c.name === "label")).toMatchObject({ hasDefault: true });

    const insert = (code: string): Change => ({
      kind: "insert_row",
      table: made,
      values: [{ column: "code", value: code }],
    });
    await run(insert("one"));
    await run(insert("two"));
    const page = await adapter.getRows(made, { pageSize: 10, cursor: null, revealColumns: [] });
    const cell = (row: number, name: string) =>
      page.rows[row]?.[page.columns.findIndex((c) => c.name === name)]?.value;
    expect([cell(0, "id"), cell(1, "id")]).toEqual(["1", "2"]);
    expect(cell(0, "label")).toBe("it's new");
    expect(cell(0, "qty")).toBe("3");
    // The unique key is enforced, with a message that holds no value.
    await expect(run(insert("one"))).rejects.toMatchObject({
      code: "unique_violation",
      message: expect.not.stringContaining("one"),
    });
  });
});
