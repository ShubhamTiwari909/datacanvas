import { changeSchema } from "@datacanvas/shared-types";
import { describe, expect, it } from "vitest";
import { affectedTables } from "./after-structure-change";
import { buildAlter, initialAlterState, type AlterState } from "./alter";
import {
  buildCreateTable,
  changeLabel,
  columnDefinitionOf,
  columnProblems,
  createTableProblems,
  defaultKindsFor,
  formatColumnType,
  newColumnForm,
  newForeignKeyForm,
  type CreateTableForm,
} from "./structure";

const users = { schema: "public", name: "users" };

describe("column types and defaults", () => {
  it("formats types with their parameters", () => {
    expect(formatColumnType({ name: "varchar", length: 255 })).toBe("varchar(255)");
    expect(formatColumnType({ name: "numeric", precision: 10, scale: 2, array: true })).toBe(
      "numeric(10,2)[]",
    );
    expect(formatColumnType({ name: "timestamptz" })).toBe("timestamptz");
  });

  it("offers only the defaults that fit a type", () => {
    expect(defaultKindsFor({ name: "uuid" })).toContain("gen_random_uuid");
    expect(defaultKindsFor({ name: "text" })).not.toContain("now");
    expect(defaultKindsFor({ name: "timestamptz" })).toContain("now");
    expect(defaultKindsFor({ name: "boolean" })).toContain("boolean");
    expect(defaultKindsFor({ name: "uuid", array: true })).toEqual(["none", "literal"]);
  });

  it("turns a column form into a definition", () => {
    expect(
      columnDefinitionOf(
        newColumnForm({
          name: "price",
          typeName: "numeric",
          precision: "10",
          scale: "2",
          defaultKind: "literal",
          defaultValue: "0",
        }),
      ),
    ).toEqual({
      name: "price",
      type: { name: "numeric", precision: 10, scale: 2 },
      nullable: true,
      default: { kind: "literal", value: "0" },
      identity: null,
      comment: null,
    });
  });

  it("makes an identity column NOT NULL without a default, and only for integer types", () => {
    const id = columnDefinitionOf(
      newColumnForm({ name: "id", typeName: "bigint", identity: "always", defaultKind: "literal" }),
    );
    expect(id).toMatchObject({ nullable: false, default: { kind: "none" }, identity: "always" });
    expect(
      columnDefinitionOf(newColumnForm({ name: "t", typeName: "text", identity: "always" }))
        .identity,
    ).toBeNull();
    expect(
      columnProblems(newColumnForm({ name: "t", typeName: "text", identity: "always" })),
    ).toEqual(["Only smallint, integer and bigint can be an identity column."]);
  });

  it("finds problems without repeating what was typed", () => {
    expect(columnProblems(newColumnForm({ name: "x".repeat(64) }))[0]).not.toContain("xxx");
    expect(columnProblems(newColumnForm({ name: "c", typeName: "char" }))).toContain(
      "char needs a length.",
    );
    expect(
      columnProblems(newColumnForm({ name: "n", typeName: "numeric", precision: "2", scale: "5" })),
    ).toContain("The scale cannot be larger than the precision.");
  });
});

describe("a new table", () => {
  const form = (overrides: Partial<CreateTableForm> = {}): CreateTableForm => ({
    schema: "public",
    name: "orders",
    columns: [
      newColumnForm({ name: "id", typeName: "bigint", identity: "always" }),
      newColumnForm({ name: "user_id", typeName: "integer", nullable: false }),
    ],
    primaryKey: ["id"],
    unique: [[]],
    foreignKeys: [],
    comment: "",
    ...overrides,
  });

  it("builds a change the server's schema accepts", () => {
    const fk = {
      ...newForeignKeyForm("public"),
      columns: ["user_id"],
      table: "users",
      referenced: ["id"],
    };
    const change = buildCreateTable(form({ foreignKeys: [fk] }));
    expect(change.unique).toEqual([]); // empty sets are left out
    expect(change.comment).toBeNull();
    expect(changeSchema.safeParse(change).success).toBe(true);
    expect(createTableProblems(form({ foreignKeys: [fk] }))).toEqual([]);
  });

  it("lists every problem", () => {
    const problems = createTableProblems(
      form({
        name: "",
        columns: [newColumnForm({ name: "a" }), newColumnForm({ name: "a" })],
        primaryKey: ["missing"],
        foreignKeys: [newForeignKeyForm("public")],
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "The table needs a name.",
        "Two columns have the same name.",
        "The primary key names a column that is not in the table.",
        "Foreign key 1: choose the table it points at.",
      ]),
    );
  });
});

describe("edit structure", () => {
  const state = (overrides: Partial<AlterState>): AlterState => ({
    ...initialAlterState(users, overrides.op),
    ...overrides,
  });

  it("builds each operation as the server expects it", () => {
    const cases: AlterState[] = [
      state({ op: "add_column", columnForm: newColumnForm({ name: "nick" }) }),
      state({ op: "rename_column", column: "email", newName: "mail" }),
      state({ op: "rename_table", newName: "people" }),
      state({
        op: "alter_column_type",
        column: "age",
        columnForm: newColumnForm({ typeName: "bigint" }),
      }),
      state({ op: "set_nullable", column: "email", nullable: false }),
      state({
        op: "set_default",
        column: "active",
        columnForm: newColumnForm({ defaultKind: "boolean", defaultBoolean: true }),
      }),
      state({ op: "add_primary_key", columns: ["id"] }),
      state({ op: "add_unique", columns: ["email"] }),
      state({ op: "create_index", columns: ["email", "id"], unique: true }),
      state({ op: "drop_constraint", constraint: "users_email_key" }),
      state({ op: "drop_index", index: "users_email_idx" }),
      state({
        op: "add_foreign_key",
        foreignKey: {
          ...newForeignKeyForm("public"),
          columns: ["team_id"],
          table: "teams",
          referenced: ["id"],
        },
      }),
      state({ op: "drop_column", column: "email", confirm: "users" }),
      state({ op: "drop_table", confirm: "users" }),
    ];
    for (const s of cases) {
      const built = buildAlter(users, s);
      expect(built.ok, s.op).toBe(true);
      if (built.ok) {
        expect(built.change.kind).toBe(s.op);
        expect(changeSchema.safeParse(built.change).success, s.op).toBe(true);
      }
    }
  });

  it("needs the table's exact name to drop", () => {
    expect(buildAlter(users, state({ op: "drop_table", confirm: "Users" })).ok).toBe(false);
    expect(buildAlter(users, state({ op: "drop_column", column: "a", confirm: "" })).ok).toBe(
      false,
    );
  });

  it("says what is missing", () => {
    expect(buildAlter(users, state({ op: "rename_column" }))).toEqual({
      ok: false,
      problem: "Choose a column.",
    });
    expect(buildAlter(users, state({ op: "create_index" })).ok).toBe(false);
    expect(buildAlter(users, state({ op: "rename_table", newName: " x" })).ok).toBe(false);
  });

  it("knows what a change makes stale", () => {
    expect(affectedTables({ kind: "drop_table", table: users, confirm: "users" }).gone).toEqual(
      users,
    );
    expect(affectedTables({ kind: "rename_table", table: users, to: "people" }).renamedTo).toEqual({
      schema: "public",
      name: "people",
    });
    expect(affectedTables({ kind: "add_unique", table: users, columns: ["email"] }).reload).toEqual(
      [users],
    );
  });

  it("labels history kinds, including unknown ones", () => {
    expect(changeLabel("drop_table")).toBe("Drop table");
    expect(changeLabel("something_new")).toBe("something_new");
  });
});
