import { describe, expect, it } from "vitest";
import { isWritableAdapter } from "../adapter.js";
import type { Change } from "../changes.js";
import type { DatabaseError } from "../errors.js";
import { MockDatabaseAdapter } from "./mock-adapter.js";

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
    await adapter.applyChange(await adapter.previewChange(update("new@x.test")));
    expect(await emails()).toEqual(["new@x.test", "b@x.test", "c@x.test"]);
  });
});
