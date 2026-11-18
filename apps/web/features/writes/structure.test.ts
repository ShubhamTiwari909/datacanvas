import { changeSchema } from "@datacanvas/shared-types";
import { describe, expect, it } from "vitest";
import { affectedTables } from "./after-structure-change";
import { buildAlter, initialAlterState, type AlterState } from "./alter";
import {
  buildCreateTable,
  changeLabel,
  columnDefinitionOf,
  columnProblems,
  columnFormPatch,
  createTableProblems,
  defaultKindsFor,
  defaultKindsForDataType,
  foreignKeyProblems,
  formatColumnType,
  newColumnForm,
  newForeignKeyForm,
  removeColumnIn,
  renameColumnIn,
  renameTableIn,
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

  it("keeps length, precision and scale inside the shared bounds", () => {
    const problems = (overrides: Parameters<typeof newColumnForm>[0]) =>
      columnProblems(newColumnForm({ name: "c", ...overrides }));
    expect(problems({ typeName: "varchar", length: "0" })).toEqual([
      "The length must be between 1 and 10485760.",
    ]);
    expect(problems({ typeName: "varchar", length: "10485761" })).toEqual([
      "The length must be between 1 and 10485760.",
    ]);
    expect(problems({ typeName: "varchar", length: "10485760" })).toEqual([]);
    expect(problems({ typeName: "varchar", length: "1" })).toEqual([]);
    expect(problems({ typeName: "numeric", precision: "0" })).toEqual([
      "The precision must be between 1 and 1000.",
    ]);
    expect(problems({ typeName: "numeric", precision: "1001" })).toEqual([
      "The precision must be between 1 and 1000.",
    ]);
    expect(problems({ typeName: "numeric", precision: "1000", scale: "1000" })).toEqual([]);
    expect(problems({ typeName: "numeric", precision: "1000", scale: "1001" })).toEqual([
      "The scale must be between 0 and 1000.",
      "The scale cannot be larger than the precision.",
    ]);
    expect(problems({ typeName: "numeric", precision: "5", scale: "x" })).toEqual([
      "The scale must be a whole number.",
    ]);
    expect(problems({ typeName: "numeric", scale: "2" })).toEqual(["A scale needs a precision."]);
  });

  it("puts a default back to none when a type change makes it unsupported", () => {
    const stamp = newColumnForm({ name: "t", typeName: "timestamptz", defaultKind: "now" });
    // Still timestamptz: nothing to reset.
    expect(columnFormPatch(stamp, { comment: "x" })).toEqual({ comment: "x" });
    // To integer: `now()` would be refused, so the form drops it along with the type change.
    expect(columnFormPatch(stamp, { typeName: "integer" })).toEqual({
      typeName: "integer",
      defaultKind: "none",
    });
    // To an array of the same type: no function defaults for arrays.
    expect(columnFormPatch(stamp, { array: true })).toEqual({ array: true, defaultKind: "none" });
    // A literal fits every type.
    const literal = newColumnForm({ typeName: "text", defaultKind: "literal" });
    expect(columnFormPatch(literal, { typeName: "integer" })).toEqual({ typeName: "integer" });
    // And what is sent never carries an unsupported default, even from stale state.
    const stale = newColumnForm({ name: "t", typeName: "integer", defaultKind: "now" });
    expect(columnDefinitionOf(stale).default).toEqual({ kind: "none" });
  });

  it("offers an existing column only the defaults its type supports", () => {
    const kinds = defaultKindsForDataType;
    expect(kinds(undefined)).toEqual(["none", "literal"]);
    expect(kinds("integer")).toEqual(["none", "literal"]);
    expect(kinds("text")).toEqual(["none", "literal"]);
    expect(kinds("character varying(255)")).toEqual(["none", "literal"]);
    expect(kinds("uuid")).toEqual(["none", "literal", "gen_random_uuid"]);
    expect(kinds("boolean")).toEqual(["none", "literal", "boolean"]);
    expect(kinds("date")).toEqual(["none", "literal", "current_date", "now"]);
    expect(kinds("timestamp without time zone")).toEqual([
      "none",
      "literal",
      "now",
      "current_date",
    ]);
    expect(kinds("timestamp(3) with time zone")).toEqual([
      "none",
      "literal",
      "now",
      "current_date",
    ]);
    expect(kinds("uuid[]")).toEqual(["none", "literal"]);
    expect(kinds("timestamp with time zone[]")).toEqual(["none", "literal"]);
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
    // The whole change, so a field that stops being mapped fails here. The empty unique set is left out.
    expect(change).toEqual({
      kind: "create_table",
      schema: "public",
      name: "orders",
      columns: [
        {
          name: "id",
          type: { name: "bigint" },
          nullable: false,
          default: { kind: "none" },
          identity: "always",
          comment: null,
        },
        {
          name: "user_id",
          type: { name: "integer" },
          nullable: false,
          default: { kind: "none" },
          identity: null,
          comment: null,
        },
      ],
      primaryKey: ["id"],
      unique: [],
      foreignKeys: [
        {
          columns: ["user_id"],
          references: { schema: "public", table: "users", columns: ["id"] },
          onDelete: "no_action",
          onUpdate: "no_action",
        },
      ],
      comment: null,
    });
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
    // All of them, in order: a lost message (the foreign key's local or referenced column) fails.
    expect(problems).toEqual([
      "The table needs a name.",
      "Two columns have the same name.",
      "The primary key names a column that is not in the table.",
      "Foreign key 1: choose columns of this table.",
      "Foreign key 1: choose the table it points at.",
      "Foreign key 1: choose the columns it points at.",
    ]);
  });

  it("refuses a foreign key that uses a column twice, on either side", () => {
    const fk = {
      ...newForeignKeyForm("public"),
      columns: ["id", "id"],
      table: "users",
      referenced: ["a", "b"],
    };
    expect(createTableProblems(form({ foreignKeys: [fk] }))).toEqual([
      "Foreign key 1: a column of this table is chosen twice.",
    ]);
    const referencedTwice = { ...fk, columns: ["id", "user_id"], referenced: ["id", "id"] };
    expect(createTableProblems(form({ foreignKeys: [referencedTwice] }))).toEqual([
      "Foreign key 1: a referenced column is chosen twice.",
    ]);
    // Blank (not chosen yet) is not "twice": it has its own message.
    expect(
      foreignKeyProblems({ columns: ["", ""], table: "t", referenced: ["", ""] }, new Set(["a"])),
    ).toEqual(["choose columns of this table.", "choose the columns it points at."]);
  });

  describe("keeping the form consistent", () => {
    const withKeys = (): CreateTableForm => {
      const base = form({
        columns: [
          newColumnForm({ id: "c1", name: "id", typeName: "bigint" }),
          newColumnForm({ id: "c2", name: "team", typeName: "integer" }),
          newColumnForm({ id: "c3", name: "owner", typeName: "integer" }),
        ],
        primaryKey: ["id"],
        unique: [["team", "owner"], ["owner"]],
        foreignKeys: [
          {
            ...newForeignKeyForm("public"),
            columns: ["team", "owner"],
            table: "teams",
            referenced: ["id", "owner_id"],
          },
        ],
      });
      return base;
    };

    it("a renamed column keeps its place in the key, the unique sets and the foreign keys", () => {
      const renamed = renameColumnIn(withKeys(), "c2", "squad");
      expect(renamed.columns.map((c) => c.name)).toEqual(["id", "squad", "owner"]);
      expect(renamed.unique).toEqual([["squad", "owner"], ["owner"]]);
      expect(renamed.foreignKeys[0]?.columns).toEqual(["squad", "owner"]);
      expect(renamed.foreignKeys[0]?.referenced).toEqual(["id", "owner_id"]);
      expect(createTableProblems(renamed)).toEqual([]);
      // The primary key follows too.
      expect(renameColumnIn(withKeys(), "c1", "pk").primaryKey).toEqual(["pk"]);
    });

    it("a blank foreign key choice is not filled in by naming a column", () => {
      const blank = form({
        columns: [newColumnForm({ id: "c1", name: "" })],
        primaryKey: [],
        foreignKeys: [newForeignKeyForm("public")],
      });
      expect(renameColumnIn(blank, "c1", "a").foreignKeys[0]?.columns).toEqual([""]);
    });

    it("a removed column leaves no key, unique set or foreign key pair that uses it", () => {
      const removed = removeColumnIn(withKeys(), "c3");
      expect(removed.columns.map((c) => c.name)).toEqual(["id", "team"]);
      expect(removed.unique).toEqual([["team"], []]);
      expect(removed.foreignKeys[0]?.columns).toEqual(["team"]);
      expect(removed.foreignKeys[0]?.referenced).toEqual(["id"]);
      expect(createTableProblems(removed)).toEqual([]);
      expect(removeColumnIn(withKeys(), "c1").primaryKey).toEqual([]);
    });

    it("a foreign key that loses its only pair keeps a blank one that says what to choose", () => {
      const only = form({
        columns: [
          newColumnForm({ id: "c1", name: "id" }),
          newColumnForm({ id: "c2", name: "team" }),
        ],
        foreignKeys: [
          { ...newForeignKeyForm("public"), columns: ["team"], table: "teams", referenced: ["id"] },
        ],
      });
      const removed = removeColumnIn(only, "c2");
      expect(removed.foreignKeys[0]).toMatchObject({
        columns: [""],
        referenced: [""],
        table: "teams",
      });
      expect(createTableProblems(removed)).toContain(
        "Foreign key 1: choose columns of this table.",
      );
    });

    it("renaming the table moves a foreign key that points at the table itself", () => {
      const self = {
        ...newForeignKeyForm("public"),
        columns: ["user_id"],
        table: "orders",
        referenced: ["id"],
      };
      const other = { ...self, table: "users" };
      const elsewhere = { ...self, schema: "audit" }; // same name, another schema: not itself
      const renamed = renameTableIn(form({ foreignKeys: [self, other, elsewhere] }), "orders2");
      expect(renamed.name).toBe("orders2");
      expect(renamed.foreignKeys.map((f) => [f.schema, f.table])).toEqual([
        ["public", "orders2"],
        ["public", "users"],
        ["audit", "orders"],
      ]);
    });

    it("nothing moves while the table has no name yet", () => {
      const fk = { ...newForeignKeyForm("public"), table: "" };
      const renamed = renameTableIn(form({ name: "", foreignKeys: [fk] }), "t");
      expect(renamed.foreignKeys[0]?.table).toBe("");
    });
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
    const nick = {
      name: "nick",
      type: { name: "text" },
      nullable: true,
      default: { kind: "none" },
      identity: null,
      comment: null,
    };
    const expected = [
      { kind: "add_column", table: users, column: nick },
      { kind: "rename_column", table: users, column: "email", to: "mail" },
      { kind: "rename_table", table: users, to: "people" },
      { kind: "alter_column_type", table: users, column: "age", type: { name: "bigint" } },
      { kind: "set_nullable", table: users, column: "email", nullable: false },
      {
        kind: "set_default",
        table: users,
        column: "active",
        default: { kind: "boolean", value: true },
      },
      { kind: "add_primary_key", table: users, columns: ["id"] },
      { kind: "add_unique", table: users, columns: ["email"] },
      { kind: "create_index", table: users, columns: ["email", "id"], unique: true },
      { kind: "drop_constraint", table: users, constraint: "users_email_key" },
      { kind: "drop_index", table: users, index: "users_email_idx" },
      {
        kind: "add_foreign_key",
        table: users,
        foreignKey: {
          columns: ["team_id"],
          references: { schema: "public", table: "teams", columns: ["id"] },
          onDelete: "no_action",
          onUpdate: "no_action",
        },
      },
      { kind: "drop_column", table: users, column: "email", confirm: "users" },
      { kind: "drop_table", table: users, confirm: "users" },
    ];
    expect(cases).toHaveLength(expected.length);
    cases.forEach((s, index) => {
      const built = buildAlter(users, s);
      expect(built.ok, s.op).toBe(true);
      if (built.ok) {
        // The whole change, not just its kind: a mapping that drops or renames a field fails here.
        expect(built.change, s.op).toEqual(expected[index]);
        expect(changeSchema.safeParse(built.change).success, s.op).toBe(true);
      }
    });
  });

  it("checks a foreign key for repeated columns and the type's bounds", () => {
    const fk = {
      ...newForeignKeyForm("public"),
      columns: ["a", "a"],
      table: "teams",
      referenced: ["id", "x"],
    };
    expect(buildAlter(users, state({ op: "add_foreign_key", foreignKey: fk }))).toEqual({
      ok: false,
      problem: "A column of this table is chosen twice.",
    });
    expect(
      buildAlter(
        users,
        state({
          op: "add_column",
          columnForm: newColumnForm({ name: "c", typeName: "varchar", length: "0" }),
        }),
      ),
    ).toEqual({ ok: false, problem: "The length must be between 1 and 10485760." });
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
