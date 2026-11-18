/**
 * The statement builders of the write path, without a database: the exact
 * text, the order of the parameters, quoting of hostile names, the conflict
 * check, the allow-lists, and that no drop ever says CASCADE.
 */
import {
  COLUMN_TYPE_NAMES,
  DatabaseError,
  type ColumnDefault,
  type ColumnDefinition,
  type ColumnType,
  type CreateTableChange,
  type PlannedStatement,
  type TableRef,
} from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { buildDeleteRow, buildInsertRow, buildUpdateRow, type TypedValue } from "./rows.js";
import { defaultFits, quoteLiteral, renderBaseType, renderDefault, renderType } from "./sql.js";
import { buildColumnDefinition, buildCreateTable, buildForeignKey } from "./structure.js";

const HOSTILE = '"; DROP TABLE users; --';
const users: TableRef = { schema: "public", name: "users" };
const typed = (column: string, castType: string, value: string | null): TypedValue => ({
  column,
  castType,
  value,
});

/** `$n` placeholders must be exactly 1..values.length, each used once, in order of first use. */
function expectDenseParameters(statement: PlannedStatement): void {
  const used = [...statement.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  expect(used).toEqual(statement.values.map((_, i) => i + 1));
}

const invalid = (work: () => unknown): DatabaseError => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toBe("invalid_change");
    return error as DatabaseError;
  }
  throw new Error("expected an invalid_change");
};

describe("row statements", () => {
  it("update: values, then the key, then what was seen; one conflict check per changed column", () => {
    const statement = buildUpdateRow(
      users,
      [typed("tenant", "integer", "7"), typed("id", "uuid", "abc")],
      [typed("email", "text", "new@x.test"), typed("age", "integer", null)],
      [
        { column: "age", value: "30" },
        { column: "email", value: null },
      ],
    );
    expect(statement.text).toBe(
      'UPDATE "public"."users" SET "email" = CAST($1 AS text), "age" = CAST($2 AS integer) ' +
        'WHERE "tenant" = CAST($3 AS integer) AND "id" = CAST($4 AS uuid) ' +
        'AND CAST("email" AS text) IS NOT DISTINCT FROM CAST($5 AS text) ' +
        'AND CAST("age" AS text) IS NOT DISTINCT FROM CAST($6 AS text) RETURNING 1',
    );
    expect(statement.values).toEqual(["new@x.test", null, "7", "abc", null, "30"]);
    expectDenseParameters(statement);
  });

  it("insert: one cast per value, or DEFAULT VALUES", () => {
    const statement = buildInsertRow(users, [typed("a", "text", "x"), typed("b", "jsonb", null)]);
    expect(statement).toEqual({
      text: 'INSERT INTO "public"."users" ("a", "b") VALUES (CAST($1 AS text), CAST($2 AS jsonb)) RETURNING 1',
      values: ["x", null],
    });
    expect(buildInsertRow(users, [])).toEqual({
      text: 'INSERT INTO "public"."users" DEFAULT VALUES RETURNING 1',
      values: [],
    });
  });

  it("delete: by the whole key", () => {
    expect(buildDeleteRow(users, [typed("a", "integer", "1"), typed("b", "text", "x")])).toEqual({
      text: 'DELETE FROM "public"."users" WHERE "a" = CAST($1 AS integer) AND "b" = CAST($2 AS text) RETURNING 1',
      values: ["1", "x"],
    });
  });

  it("a hostile name or value never becomes SQL: names are quoted, values are parameters", () => {
    const table = { schema: HOSTILE, name: HOSTILE };
    const value = "'; DROP TABLE users; --";
    const statements = [
      buildUpdateRow(
        table,
        [typed(HOSTILE, "integer", value)],
        [typed(HOSTILE, "text", value)],
        [{ column: HOSTILE, value }],
      ),
      buildInsertRow(table, [typed(HOSTILE, "text", value)]),
      buildDeleteRow(table, [typed(HOSTILE, "integer", value)]),
    ];
    const quoted = '"""; DROP TABLE users; --"';
    for (const statement of statements) {
      expectDenseParameters(statement);
      // The value appears only among the parameters.
      expect(statement.text).not.toContain(value);
      expect(statement.values.every((v) => v === value)).toBe(true);
      // Take the quoted names out: nothing of the hostile text is left, and no stray quote or semicolon.
      const rest = statement.text.split(quoted).join("X");
      expect(rest).not.toMatch(/DROP|;|--|'/);
      expect(rest).toMatch(/^(UPDATE|INSERT INTO|DELETE FROM) X\.X /);
    }
  });
});

describe("literals", () => {
  it("doubles quotes, escapes backslashes, refuses NUL", () => {
    expect(quoteLiteral("plain")).toBe("'plain'");
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral("'; DROP TABLE x; --")).toBe("'''; DROP TABLE x; --'");
    expect(quoteLiteral("a\\b")).toBe("E'a\\\\b'");
    expect(quoteLiteral("\\'")).toBe("E'\\\\'''");
    expect(quoteLiteral("")).toBe("''");
    invalid(() => quoteLiteral("a\0b"));
  });
});

describe("types", () => {
  it("renders every type on the allow-list, and nothing else", () => {
    for (const name of COLUMN_TYPE_NAMES) {
      expect(renderType({ name })).toMatch(/^[a-z ]+$/);
      expect(renderType({ name, array: true })).toBe(`${renderType({ name })}[]`);
      expect(renderBaseType({ name, array: true })).toBe(`${renderType({ name })}[]`);
    }
    expect(renderType({ name: "varchar", length: 255 })).toBe("character varying(255)");
    expect(renderType({ name: "char", length: 2, array: true })).toBe("character(2)[]");
    expect(renderType({ name: "numeric", precision: 10 })).toBe("numeric(10)");
    expect(renderType({ name: "numeric", precision: 10, scale: 2 })).toBe("numeric(10,2)");
    expect(renderBaseType({ name: "numeric", precision: 10, scale: 2 })).toBe("numeric");
    for (const name of ["serial", "integer; DROP TABLE x", "__proto__", "toString", ""]) {
      invalid(() => renderType({ name } as unknown as ColumnType));
    }
  });

  it("checks the parameters again, whatever the request schema let through", () => {
    const bad: ColumnType[] = [
      { name: "integer", length: 5 },
      { name: "varchar", length: 0 },
      { name: "varchar", length: 1.5 },
      { name: "varchar", length: 10_485_761 },
      { name: "varchar", length: "5); DROP TABLE x; --" as unknown as number },
      { name: "text", precision: 5 },
      { name: "numeric", scale: 2 },
      { name: "numeric", precision: 0 },
      { name: "numeric", precision: 1001 },
      { name: "numeric", precision: 5, scale: 6 },
      { name: "numeric", precision: 5, scale: -1 },
      { name: "numeric", precision: 5, scale: "1" as unknown as number },
    ];
    for (const type of bad) invalid(() => renderType(type));
  });
});

describe("defaults", () => {
  const sql = (value: ColumnDefault, type: ColumnType, uuid: string | null = null) =>
    renderDefault(value, renderType(type), renderBaseType(type), uuid);

  it("renders the fixed list", () => {
    expect(sql({ kind: "none" }, { name: "text" })).toBeNull();
    expect(sql({ kind: "literal", value: "it's" }, { name: "varchar", length: 9 })).toBe(
      "CAST('it''s' AS character varying(9))",
    );
    expect(sql({ kind: "literal", value: "now()" }, { name: "text" })).toBe(
      "CAST('now()' AS text)", // text, not a function call
    );
    expect(sql({ kind: "now" }, { name: "timestamptz" })).toBe("now()");
    expect(sql({ kind: "current_date" }, { name: "date" })).toBe("CURRENT_DATE");
    expect(sql({ kind: "boolean", value: false }, { name: "boolean" })).toBe("false");
    expect(
      sql({ kind: "gen_random_uuid" }, { name: "uuid" }, '"pg_catalog"."gen_random_uuid"'),
    ).toBe('"pg_catalog"."gen_random_uuid"()');
  });

  it("refuses a default that does not fit the type, or a function the server lacks", () => {
    invalid(() => sql({ kind: "now" }, { name: "text" }));
    invalid(() => sql({ kind: "now" }, { name: "timestamptz", array: true }));
    invalid(() => sql({ kind: "current_date" }, { name: "time" }));
    invalid(() => sql({ kind: "boolean", value: true }, { name: "integer" }));
    invalid(() =>
      sql({ kind: "gen_random_uuid" }, { name: "text" }, '"pg_catalog"."gen_random_uuid"'),
    );
    expect(
      invalid(() => sql({ kind: "gen_random_uuid" }, { name: "uuid" }, null)).message,
    ).toContain("pgcrypto");
    invalid(() => sql({ kind: "literal", value: "a\0" }, { name: "text" }));
    expect(defaultFits("literal", "anything at all")).toBe(true);
    expect(defaultFits("none", "anything at all")).toBe(true);
  });
});

const column = (
  name: string,
  type: ColumnType,
  extra: Partial<ColumnDefinition> = {},
): ColumnDefinition => ({
  name,
  type,
  nullable: true,
  default: { kind: "none" },
  identity: null,
  comment: null,
  ...extra,
});

describe("column definitions", () => {
  it("renders name, type, identity, NOT NULL and default in a fixed order", () => {
    expect(buildColumnDefinition(column("a", { name: "integer" }), null)).toBe('"a" integer');
    expect(
      buildColumnDefinition(
        column(
          "a b",
          { name: "text" },
          { nullable: false, default: { kind: "literal", value: "x" } },
        ),
        null,
      ),
    ).toBe(`"a b" text NOT NULL DEFAULT CAST('x' AS text)`);
    expect(
      buildColumnDefinition(column("id", { name: "bigint" }, { identity: "always" }), null),
    ).toBe('"id" bigint GENERATED ALWAYS AS IDENTITY');
    expect(
      buildColumnDefinition(
        column("id", { name: "smallint" }, { identity: "by_default", nullable: true }),
        null,
      ),
    ).toBe('"id" smallint GENERATED BY DEFAULT AS IDENTITY');
  });

  it("refuses a bad name, an identity of the wrong type, and an identity with a default", () => {
    for (const name of ["", " a", "a ", "a\0", "x".repeat(64), "é".repeat(32)]) {
      invalid(() => buildColumnDefinition(column(name, { name: "integer" }), null));
    }
    expect(buildColumnDefinition(column("é".repeat(31), { name: "integer" }), null)).toContain(
      "integer",
    );
    invalid(() =>
      buildColumnDefinition(column("a", { name: "text" }, { identity: "always" }), null),
    );
    invalid(() =>
      buildColumnDefinition(
        column("a", { name: "integer", array: true }, { identity: "always" }),
        null,
      ),
    );
    invalid(() =>
      buildColumnDefinition(
        column(
          "a",
          { name: "integer" },
          { identity: "always", default: { kind: "literal", value: "1" } },
        ),
        null,
      ),
    );
  });
});

describe("create table", () => {
  const change: CreateTableChange = {
    kind: "create_table",
    schema: "app",
    name: HOSTILE,
    columns: [
      column("id", { name: "integer" }, { identity: "always" }),
      column(HOSTILE, { name: "text" }, { comment: "it's; DROP TABLE x" }),
    ],
    primaryKey: ["id"],
    unique: [[HOSTILE, "id"]],
    foreignKeys: [
      {
        columns: [HOSTILE],
        references: { schema: HOSTILE, table: HOSTILE, columns: [HOSTILE] },
        onDelete: "cascade",
        onUpdate: "set_default",
      },
    ],
    comment: "a \\ table",
  };

  it("builds one CREATE TABLE and one COMMENT per comment", () => {
    const q = '"""; DROP TABLE users; --"';
    expect(buildCreateTable(change, null).map((s) => s.text)).toEqual([
      `CREATE TABLE "app".${q} (\n` +
        `  "id" integer GENERATED ALWAYS AS IDENTITY,\n` +
        `  ${q} text,\n` +
        `  PRIMARY KEY ("id"),\n` +
        `  UNIQUE (${q}, "id"),\n` +
        `  FOREIGN KEY (${q}) REFERENCES ${q}.${q} (${q}) ON DELETE CASCADE ON UPDATE SET DEFAULT\n` +
        `)`,
      `COMMENT ON TABLE "app".${q} IS E'a \\\\ table'`,
      `COMMENT ON COLUMN "app".${q}.${q} IS 'it''s; DROP TABLE x'`,
    ]);
    // No statement of a structure change carries a parameter: DDL cannot take them.
    expect(buildCreateTable(change, null).every((s) => s.values.length === 0)).toBe(true);
  });

  it("an empty comment is no comment; a bad table name is refused", () => {
    expect(
      buildCreateTable(
        {
          ...change,
          comment: "",
          columns: [column("a", { name: "text" })],
          unique: [],
          foreignKeys: [],
          primaryKey: [],
        },
        null,
      ),
    ).toHaveLength(1);
    invalid(() => buildCreateTable({ ...change, name: "" }, null));
    invalid(() => buildCreateTable({ ...change, name: "n".repeat(64) }, null));
  });

  it("writes every referential action from the fixed table", () => {
    const fk = (onDelete: string, onUpdate: string) =>
      buildForeignKey({
        columns: ["a"],
        references: { schema: "s", table: "t", columns: ["b"] },
        onDelete,
        onUpdate,
      } as Parameters<typeof buildForeignKey>[0]);
    expect(fk("no_action", "restrict")).toBe(
      'FOREIGN KEY ("a") REFERENCES "s"."t" ("b") ON DELETE NO ACTION ON UPDATE RESTRICT',
    );
    expect(fk("set_null", "cascade")).toBe(
      'FOREIGN KEY ("a") REFERENCES "s"."t" ("b") ON DELETE SET NULL ON UPDATE CASCADE',
    );
    // An action that is not in the table cannot be smuggled in.
    invalid(() => fk("cascade; DROP TABLE x", "no_action"));
    invalid(() => fk("no_action", "__proto__"));
    invalid(() => fk("toString", "no_action"));
  });
});
