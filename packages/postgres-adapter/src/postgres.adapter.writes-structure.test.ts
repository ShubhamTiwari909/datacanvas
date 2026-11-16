/**
 * Creating and altering tables against a real PostgreSQL
 * (`docs/data-editing-plan.md`, sections 6.5, 6.6 and 9): every operation is
 * previewed and applied, what was created matches what was previewed, awkward
 * names are just names, refusals name structure and never a value, and a drop
 * that something depends on is refused (no CASCADE).
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import {
  COLUMN_TYPE_NAMES,
  DatabaseError,
  statementText,
  type Change,
  type ColumnDefault,
  type ColumnDefinition,
  type ColumnType,
  type CreateTableChange,
  type PlannedChange,
  type TableRef,
} from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SECRET = "hunter2-SECRET-VALUE";
const NAME_63 = `s_${"n".repeat(61)}`;
const HOSTILE = '"; DROP TABLE s_keep; --';

const SQL = `
  CREATE SCHEMA other;
  CREATE TABLE s_keep (id int PRIMARY KEY, code text UNIQUE, plain text);
  INSERT INTO s_keep VALUES (1, 'a', 'x'), (2, 'b', 'x');
  CREATE TABLE other.target (a int, b int, v text, PRIMARY KEY (a, b));

  CREATE TABLE s_alter (
    id int PRIMARY KEY, n int, small varchar(5), label text, big bigint, arr int[],
    viewed text, indexed text, linked int REFERENCES s_keep (id), counter serial, free text, conv int
  );
  INSERT INTO s_alter (id, n, small, label, big, viewed, indexed, linked, free)
    VALUES (1, 1, 'ab', '12', 5000000000, 'v', 'i', 1, NULL), (2, 2, 'cd', '${SECRET}', 1, 'v', 'i', 2, 'f');
  ANALYZE s_alter;
  CREATE VIEW s_alter_view AS SELECT id, viewed FROM s_alter;
  CREATE INDEX s_alter_indexed_idx ON s_alter (indexed);
  CREATE UNIQUE INDEX s_alter_n_uq ON s_alter (n);

  CREATE TABLE s_child (id int PRIMARY KEY, parent int REFERENCES s_alter (id), orphan int);
  INSERT INTO s_child VALUES (1, 1, 999);

  CREATE TABLE s_nopk (a int, b int, dup int, nullable int);
  INSERT INTO s_nopk VALUES (1, 1, 7, NULL), (2, 2, 7, 1);

  CREATE TABLE s_drop_plain (id int PRIMARY KEY, v text);
  CREATE TABLE s_drop_self (id int PRIMARY KEY, parent int REFERENCES s_drop_self (id));
  CREATE TABLE s_drop_viewed (id int PRIMARY KEY);
  CREATE VIEW s_drop_view AS SELECT id FROM s_drop_viewed;
  CREATE TABLE s_drop_referenced (id int PRIMARY KEY);
  CREATE TABLE s_drop_referrer (id int PRIMARY KEY, r int REFERENCES s_drop_referenced (id));
  CREATE TABLE s_rename (id int PRIMARY KEY, old_name text);
  CREATE VIEW s_rename_view AS SELECT old_name FROM s_rename;
  CREATE VIEW s_view AS SELECT 1 AS one;
`;

const col = (
  name: string,
  type: ColumnType | ColumnType["name"],
  extra: Partial<ColumnDefinition> = {},
): ColumnDefinition => ({
  name,
  type: typeof type === "string" ? { name: type } : type,
  nullable: true,
  default: { kind: "none" },
  identity: null,
  comment: null,
  ...extra,
});

describe.skipIf(!testDatabaseUrl())("PostgresAdapter structure changes", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;
  let sql: pg.Client;
  let serverVersion = 0;
  const previewed: string[] = [];

  const ref = (name: string, schema = "public"): TableRef => ({ schema, name });
  const rows = async <T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<T[]> => (await sql.query(text, values)).rows as T[];
  const apply = async (change: Change): Promise<PlannedChange> => {
    const plan = await adapter.previewChange(change);
    await adapter.applyChange(plan);
    return plan;
  };
  const create = (
    name: string,
    columns: ColumnDefinition[],
    extra: Partial<CreateTableChange> = {},
  ): Change =>
    ({
      kind: "create_table",
      schema: "public",
      name,
      columns,
      primaryKey: [],
      unique: [],
      foreignKeys: [],
      comment: null,
      ...extra,
    }) as Change;

  async function failure(work: Promise<unknown>, secret = SECRET): Promise<DatabaseError> {
    const error = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DatabaseError);
    const failed = error as DatabaseError;
    expect(failed.message).not.toContain(secret);
    expect(JSON.stringify(failed)).not.toContain(secret);
    return failed;
  }

  /** Columns of a table as the catalog has them. */
  const columnsOf = (table: string, schema = "public") =>
    rows<{ name: string; type: string; notnull: boolean; def: string | null; identity: string }>(
      `SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type,
         a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity::text AS identity
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $2 AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [table, schema],
    );
  const exists = async (table: string, schema = "public"): Promise<boolean> =>
    (
      await rows(
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $2 AND c.relname = $1",
        [table, schema],
      )
    ).length > 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    sql = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await sql.connect();
    await sql.query(SQL);
    serverVersion = Number(
      (await rows<{ v: string }>("SELECT current_setting('server_version_num') AS v"))[0]?.v ?? 0,
    );
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
    // Keep the text of every statement any test previews, for the last test of the file.
    const preview = adapter.previewChange.bind(adapter);
    adapter.previewChange = async (change) => {
      const plan = await preview(change);
      previewed.push(statementText(plan));
      return plan;
    };
  }, 60_000);

  afterAll(async () => {
    await adapter?.disconnect();
    await sql?.end();
    await db?.dispose();
  });

  describe("create table", () => {
    it("creates what the preview shows: types, identity, defaults, keys, foreign keys, comments", async () => {
      const change = create(
        "s_new",
        [
          col("id", "bigint", { identity: "always" }),
          col("code", { name: "varchar", length: 20 }, { nullable: false }),
          col(
            "price",
            { name: "numeric", precision: 10, scale: 2 },
            {
              default: { kind: "literal", value: "9.99" },
            },
          ),
          col("active", "boolean", { default: { kind: "boolean", value: true }, nullable: false }),
          col("made", "timestamptz", { default: { kind: "now" } }),
          col("day", "date", { default: { kind: "current_date" } }),
          col("note", "text", {
            default: { kind: "literal", value: `it's a \\ "quoted" default` },
            comment: "A note; with 'quotes'",
          }),
          col("tags", { name: "text", array: true }, { default: { kind: "literal", value: "{}" } }),
          col("keep_id", "integer"),
          col("ta", "integer"),
          col("tb", "integer"),
          col("parent", "bigint"),
        ],
        {
          primaryKey: ["id"],
          unique: [["code"], ["keep_id", "code"]],
          foreignKeys: [
            {
              columns: ["keep_id"],
              references: { schema: "public", table: "s_keep", columns: ["id"] },
              onDelete: "cascade",
              onUpdate: "no_action",
            },
            {
              columns: ["ta", "tb"],
              references: { schema: "other", table: "target", columns: ["a", "b"] },
              onDelete: "set_null",
              onUpdate: "restrict",
            },
            {
              columns: ["parent"],
              references: { schema: "public", table: "s_new", columns: ["id"] },
              onDelete: "no_action",
              onUpdate: "no_action",
            },
          ],
          comment: "The new table",
        } as Partial<CreateTableChange>,
      );
      const plan = await adapter.previewChange(change);
      expect(plan).toMatchObject({ expect: "any", category: "structure", destructive: false });
      expect(plan.effect).toBe("Creates the table public.s_new with 12 columns.");
      expect(statementText(plan)).toBe(
        [
          'CREATE TABLE "public"."s_new" (',
          '  "id" bigint GENERATED ALWAYS AS IDENTITY,',
          '  "code" character varying(20) NOT NULL,',
          `  "price" numeric(10,2) DEFAULT CAST('9.99' AS numeric(10,2)),`,
          '  "active" boolean NOT NULL DEFAULT true,',
          '  "made" timestamp with time zone DEFAULT now(),',
          '  "day" date DEFAULT CURRENT_DATE,',
          `  "note" text DEFAULT CAST(E'it''s a \\\\ "quoted" default' AS text),`,
          `  "tags" text[] DEFAULT CAST('{}' AS text[]),`,
          '  "keep_id" integer,',
          '  "ta" integer,',
          '  "tb" integer,',
          '  "parent" bigint,',
          '  PRIMARY KEY ("id"),',
          '  UNIQUE ("code"),',
          '  UNIQUE ("keep_id", "code"),',
          '  FOREIGN KEY ("keep_id") REFERENCES "public"."s_keep" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,',
          '  FOREIGN KEY ("ta", "tb") REFERENCES "other"."target" ("a", "b") ON DELETE SET NULL ON UPDATE RESTRICT,',
          '  FOREIGN KEY ("parent") REFERENCES "public"."s_new" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION',
          ");",
          `COMMENT ON TABLE "public"."s_new" IS 'The new table';`,
          `COMMENT ON COLUMN "public"."s_new"."note" IS 'A note; with ''quotes''';`,
        ].join("\n"),
      );
      // Previewing created nothing.
      expect(await exists("s_new")).toBe(false);
      await adapter.applyChange(plan);

      const columns = await columnsOf("s_new");
      expect(columns.map((c) => [c.name, c.type, c.notnull])).toEqual([
        ["id", "bigint", true],
        ["code", "character varying(20)", true],
        ["price", "numeric(10,2)", false],
        ["active", "boolean", true],
        ["made", "timestamp with time zone", false],
        ["day", "date", false],
        ["note", "text", false],
        ["tags", "text[]", false],
        ["keep_id", "integer", false],
        ["ta", "integer", false],
        ["tb", "integer", false],
        ["parent", "bigint", false],
      ]);
      expect(columns[0]!.identity).toBe("a");
      const constraints = await adapter.getConstraints("public", "s_new");
      expect(constraints.map((c) => c.kind).sort()).toEqual([
        "foreign_key",
        "foreign_key",
        "foreign_key",
        "primary_key",
        "unique",
        "unique",
      ]);
      // The defaults mean what was typed, quotes and backslash included.
      await sql.query("INSERT INTO s_new (code) VALUES ('c1')");
      expect(await rows("SELECT id, price::text, active, note, tags FROM s_new")).toEqual([
        { id: "1", price: "9.99", active: true, note: `it's a \\ "quoted" default`, tags: [] },
      ]);
      const [table] = (await adapter.getTables("public")).filter((t) => t.name === "s_new");
      expect(table?.comment).toBe("The new table");
      expect(
        (await adapter.getColumns("public", "s_new")).find((c) => c.name === "note")?.comment,
      ).toBe("A note; with 'quotes'");
      // And its rows can be edited by its key.
      expect(await adapter.describeForEdit(ref("s_new"))).toMatchObject({
        editable: true,
        key: ["id"],
      });
    });

    it("creates a column of every type on the allow-list, plain and as an array", async () => {
      const params: Partial<Record<ColumnType["name"], Partial<ColumnType>>> = {
        varchar: { length: 10 },
        char: { length: 3 },
        numeric: { precision: 8, scale: 3 },
      };
      const columns = COLUMN_TYPE_NAMES.flatMap((name, i) => [
        col(`c${i}`, { name, ...params[name] }),
        col(`a${i}`, { name, ...params[name], array: true }),
      ]);
      await apply(create("s_all_types", columns));
      const made = await columnsOf("s_all_types");
      expect(made).toHaveLength(COLUMN_TYPE_NAMES.length * 2);
      expect(made.filter((c) => c.name.startsWith("c")).map((c) => c.type)).toEqual([
        "smallint",
        "integer",
        "bigint",
        "numeric(8,3)",
        "real",
        "double precision",
        "boolean",
        "text",
        "character varying(10)",
        "character(3)",
        "date",
        "time without time zone",
        "timestamp without time zone",
        "timestamp with time zone",
        "interval",
        "uuid",
        "json",
        "jsonb",
        "bytea",
        "inet",
      ]);
      expect(made.filter((c) => c.name.startsWith("a")).every((c) => c.type.endsWith("[]"))).toBe(
        true,
      );
      // No primary key: the preview says its rows will not be editable.
      const plan = await adapter.previewChange(create("s_other", [col("a", "integer")]));
      expect(plan.warnings.map((w) => w.code)).toEqual(["may_fail"]);
    });

    it("treats hostile, quoted, Unicode and 63-byte names as names", async () => {
      const plan = await apply(
        create(
          HOSTILE,
          [
            col('col "x"; --', "integer"),
            col("Ünï cødé", "text"),
            col("select", "text"),
            col(NAME_63, "text"),
          ],
          {
            primaryKey: ['col "x"; --'],
            comment: `'); DROP TABLE s_keep; --`,
          } as Partial<CreateTableChange>,
        ),
      );
      expect(plan.statements[0]!.text).toContain(
        'CREATE TABLE "public"."""; DROP TABLE s_keep; --" (',
      );
      expect(plan.statements[0]!.text).toContain('"col ""x""; --" integer');
      expect(await exists(HOSTILE)).toBe(true);
      expect(await exists("s_keep")).toBe(true);
      expect((await columnsOf(HOSTILE)).map((c) => c.name)).toEqual([
        'col "x"; --',
        "Ünï cødé",
        "select",
        NAME_63,
      ]);
      await apply(
        create(NAME_63, [col("id", "integer")], { schema: "other" } as Partial<CreateTableChange>),
      );
      expect(await exists(NAME_63, "other")).toBe(true);
      // And it can be dropped again by its exact name.
      await apply({ kind: "drop_table", table: ref(HOSTILE), confirm: HOSTILE });
      expect(await exists(HOSTILE)).toBe(false);
      expect(await exists("s_keep")).toBe(true);
    });

    it("offers gen_random_uuid() only where the server has it", async () => {
      const change = create("s_uuid", [
        col("id", "uuid", { default: { kind: "gen_random_uuid" }, nullable: false }),
      ]);
      if (serverVersion >= 130000) {
        const plan = await apply(change);
        expect(plan.statements[0]!.text).toContain('DEFAULT "pg_catalog"."gen_random_uuid"()');
      } else {
        const refused = await failure(adapter.previewChange(change));
        expect(refused.code).toBe("invalid_change");
        expect(refused.message).toContain("gen_random_uuid");
        await sql.query("CREATE EXTENSION pgcrypto");
        const plan = await apply(change);
        expect(plan.statements[0]!.text).toContain('DEFAULT "public"."gen_random_uuid"()');
      }
      await sql.query("INSERT INTO s_uuid DEFAULT VALUES");
      expect((await rows<{ id: string }>("SELECT id FROM s_uuid"))[0]?.id).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });

    it("refuses what cannot be created, naming structure only", async () => {
      const refuse = async (change: Change, code: string, word: string) => {
        const error = await failure(adapter.previewChange(change));
        expect([error.code, error.message]).toEqual([code, expect.stringContaining(word)]);
      };
      const a = col("a", "integer");
      await refuse(create("s_keep", [a]), "already_exists", "public.s_keep");
      await refuse(create("s_alter_indexed_idx", [a]), "already_exists", "already exists"); // an index has the name
      await refuse(
        create("x", [a], { schema: "nope" } as Partial<CreateTableChange>),
        "not_found",
        "schema",
      );
      await refuse(
        create("x", [a], { schema: "pg_catalog" } as Partial<CreateTableChange>),
        "not_found",
        "schema",
      );
      await refuse(
        create("x", [a], { primaryKey: ["b"] } as Partial<CreateTableChange>),
        "invalid_change",
        "primary key",
      );
      await refuse(create("x", [a, col("a", "text")]), "invalid_change", "same name");
      await refuse(create("x", []), "invalid_change", "at least one column");
      await refuse(create("", [a]), "invalid_change", "name");
      await refuse(create("n".repeat(64), [a]), "invalid_change", "63 bytes");
      await refuse(create("x", [col("bad\0name", "integer")]), "invalid_change", "name");
      await refuse(
        create("x", [col("t", "text", { identity: "always" })]),
        "invalid_change",
        "identity",
      );
      await refuse(
        create("x", [col("t", "text", { default: { kind: "now" } })]),
        "invalid_change",
        "does not fit",
      );
      await refuse(
        create("x", [
          col("t", { name: "uuid", array: true }, { default: { kind: "gen_random_uuid" } }),
        ]),
        "invalid_change",
        "does not fit",
      );
      await refuse(
        create("x", [col("t", { name: "integer", length: 5 } as ColumnType)]),
        "invalid_change",
        "length",
      );
      await refuse(
        create("x", [col("t", { name: "sql; DROP TABLE s_keep" } as unknown as ColumnType)]),
        "invalid_change",
        "not offered",
      );
      await refuse(
        create("x", [col("n", "integer", { default: { kind: "literal", value: SECRET } })]),
        "invalid_value",
        "n",
      );
      const fk = (columns: string[], table: string, target: string[]) =>
        create("x", [a, col("b", "integer")], {
          foreignKeys: [
            {
              columns,
              references: { schema: "public", table, columns: target },
              onDelete: "no_action",
              onUpdate: "no_action",
            },
          ],
        } as Partial<CreateTableChange>);
      await refuse(fk(["a"], "nope", ["id"]), "invalid_change", "public.nope does not exist");
      await refuse(fk(["a"], "s_view", ["one"]), "invalid_change", "does not exist");
      await refuse(fk(["a"], "s_keep", ["nope"]), "invalid_change", "nope");
      await refuse(fk(["a"], "s_keep", ["plain"]), "invalid_change", "unique key");
      await refuse(fk(["a", "b"], "s_keep", ["id"]), "invalid_change", "as many");
      await refuse(fk(["a"], "x", ["b"]), "invalid_change", "the new table itself");
      await refuse(fk(["zzz"], "s_keep", ["id"]), "invalid_change", "zzz");
      // A unique key of the target is accepted as well as its primary key.
      const plan = await adapter.previewChange(fk(["a"], "s_keep", ["code"]));
      expect(plan.statements[0]!.text).toContain('REFERENCES "public"."s_keep" ("code")');
      expect(await exists("x")).toBe(false);
    });

    it("maps a failure the database finds at apply to a fixed message", async () => {
      // text -> integer foreign key: the types are only compared by the database.
      const plan = await adapter.previewChange(
        create("s_mismatch", [col("a", "text")], {
          foreignKeys: [
            {
              columns: ["a"],
              references: { schema: "public", table: "s_keep", columns: ["id"] },
              onDelete: "no_action",
              onUpdate: "no_action",
            },
          ],
        } as Partial<CreateTableChange>),
      );
      const error = await failure(adapter.applyChange(plan));
      expect(error.code).toBe("invalid_change");
      expect(await exists("s_mismatch")).toBe(false);
      // Created by someone else between preview and apply.
      const late = await adapter.previewChange(create("s_race", [col("a", "integer")]));
      await sql.query("CREATE TABLE s_race (x int)");
      expect((await failure(adapter.applyChange(late))).code).toBe("already_exists");
    });
  });

  describe("columns", () => {
    it("adds a column, with its default and comment", async () => {
      const plan = await apply({
        kind: "add_column",
        table: ref("s_alter"),
        column: col(
          "added",
          { name: "varchar", length: 8 },
          {
            nullable: false,
            default: { kind: "literal", value: "new" },
            comment: "added later",
          },
        ),
      });
      expect(statementText(plan)).toBe(
        [
          `ALTER TABLE "public"."s_alter" ADD COLUMN "added" character varying(8) NOT NULL DEFAULT CAST('new' AS character varying(8));`,
          `COMMENT ON COLUMN "public"."s_alter"."added" IS 'added later';`,
        ].join("\n"),
      );
      expect(plan.warnings.map((w) => w.code)).toEqual(["lock"]);
      expect(await rows("SELECT DISTINCT added FROM s_alter")).toEqual([{ added: "new" }]);
      // An identity column fills the existing rows.
      const identity = await apply({
        kind: "add_column",
        table: ref("s_alter"),
        column: col("seq", "integer", { identity: "by_default" }),
      });
      expect(identity.warnings.map((w) => w.code)).toEqual(["lock", "rewrite"]);
      expect(await rows("SELECT seq FROM s_alter ORDER BY id")).toEqual([{ seq: 1 }, { seq: 2 }]);
    });

    it("warns that NOT NULL without a default fails on a table with rows, and it does", async () => {
      const plan = await adapter.previewChange({
        kind: "add_column",
        table: ref("s_alter"),
        column: col("must", "integer", { nullable: false }),
      });
      expect(plan.warnings.map((w) => w.code)).toEqual(["lock", "may_fail"]);
      const error = await failure(adapter.applyChange(plan));
      expect(error.code).toBe("not_null_violation");
      expect(error.message).toContain("must");
      // A name that exists is refused at preview.
      const taken = await failure(
        adapter.previewChange({
          kind: "add_column",
          table: ref("s_alter"),
          column: col("n", "text"),
        }),
      );
      expect(taken.code).toBe("already_exists");
    });

    it("renames a column and a table, warning about what uses the old name", async () => {
      const column = await apply({
        kind: "rename_column",
        table: ref("s_rename"),
        column: "old_name",
        to: 'new "name"',
      });
      expect(statementText(column)).toBe(
        'ALTER TABLE "public"."s_rename" RENAME COLUMN "old_name" TO "new ""name""";',
      );
      const renamed = column.warnings.find((w) => w.code === "renamed");
      expect(renamed?.message).toContain("public.s_rename_view");
      expect(renamed?.message).toContain("old name will break");
      const table = await apply({ kind: "rename_table", table: ref("s_rename"), to: "s_renamed" });
      expect(statementText(table)).toBe('ALTER TABLE "public"."s_rename" RENAME TO "s_renamed";');
      expect(table.warnings.find((w) => w.code === "renamed")?.message).toContain(
        "public.s_rename_view",
      );
      expect((await columnsOf("s_renamed")).map((c) => c.name)).toEqual(["id", 'new "name"']);
      // The view still works.
      expect(await rows("SELECT * FROM s_rename_view")).toEqual([]);

      const refuse = async (change: Change, code: string) =>
        expect((await failure(adapter.previewChange(change))).code).toBe(code);
      await refuse(
        { kind: "rename_table", table: ref("s_renamed"), to: "s_keep" },
        "already_exists",
      );
      await refuse(
        { kind: "rename_table", table: ref("s_renamed"), to: "s_view" },
        "already_exists",
      );
      await refuse(
        { kind: "rename_column", table: ref("s_renamed"), column: "id", to: 'new "name"' },
        "already_exists",
      );
      await refuse(
        { kind: "rename_column", table: ref("s_renamed"), column: "nope", to: "x" },
        "invalid_change",
      );
      await refuse({ kind: "rename_table", table: ref("s_renamed"), to: " x" }, "invalid_change");
      await refuse({ kind: "rename_table", table: ref("nope"), to: "x" }, "not_found");
      await refuse({ kind: "rename_table", table: ref("s_view"), to: "x" }, "not_editable");
    });

    it("changes a type only where PostgreSQL converts on its own", async () => {
      const retype = (column: string, type: ColumnType): Change => ({
        kind: "alter_column_type",
        table: ref("s_alter"),
        column,
        type,
      });
      const widen = await apply(retype("n", { name: "bigint" }));
      expect(statementText(widen)).toBe(
        'ALTER TABLE "public"."s_alter" ALTER COLUMN "n" TYPE bigint;',
      );
      expect(widen.warnings.map((w) => w.code)).toEqual(["lock", "rewrite", "may_fail"]);
      expect(widen.warnings[1]!.message).toContain("about 2 rows");
      await apply(retype("small", { name: "varchar", length: 10 })); // same type, longer
      await apply(retype("small", { name: "text" })); // an implicit cast
      await apply(retype("conv", { name: "text" })); // anything converts to text...
      await apply(retype("conv", { name: "varchar", length: 30 }));
      const types = new Map((await columnsOf("s_alter")).map((c) => [c.name, c.type]));
      expect([types.get("conv"), types.get("n"), types.get("small")]).toEqual([
        "character varying(30)",
        "bigint",
        "text",
      ]);

      const refuse = async (change: Change, code: string, word: string) => {
        const error = await failure(adapter.previewChange(change));
        expect([error.code, error.message]).toEqual([code, expect.stringContaining(word)]);
      };
      // ...but text converts to a number only with an expression, which is not offered.
      await refuse(retype("label", { name: "integer" }), "invalid_change", "conversion expression");
      await refuse(retype("arr", { name: "bigint", array: true }), "invalid_change", "conversion");
      await refuse(retype("arr", { name: "text" }), "invalid_change", "conversion");
      await refuse(retype("n", { name: "integer", array: true }), "invalid_change", "conversion");
      await refuse(
        retype("viewed", { name: "varchar", length: 9 }),
        "has_dependents",
        "s_alter_view",
      );
      await refuse(retype("nope", { name: "text" }), "invalid_change", "nope");
      // A value that does not fit the new type: a fixed message, never the value.
      const error = await failure(
        adapter.applyChange(await adapter.previewChange(retype("big", { name: "integer" }))),
        "5000000000",
      );
      expect(error.code).toBe("invalid_value");
      expect((await columnsOf("s_alter")).find((c) => c.name === "big")?.type).toBe("bigint");
    });

    it("sets and drops NOT NULL", async () => {
      const set = (column: string, nullable: boolean, table = "s_nopk"): Change => ({
        kind: "set_nullable",
        table: ref(table),
        column,
        nullable,
      });
      const plan = await apply(set("a", false));
      expect(statementText(plan)).toBe(
        'ALTER TABLE "public"."s_nopk" ALTER COLUMN "a" SET NOT NULL;',
      );
      expect(plan.warnings.map((w) => w.code)).toEqual(["lock", "scan", "may_fail"]);
      const error = await failure(
        adapter.applyChange(await adapter.previewChange(set("nullable", false))),
      );
      expect(error.code).toBe("not_null_violation");
      expect(error.message).toContain("nullable");
      const drop = await apply(set("a", true));
      expect(statementText(drop)).toBe(
        'ALTER TABLE "public"."s_nopk" ALTER COLUMN "a" DROP NOT NULL;',
      );
      expect((await columnsOf("s_nopk"))[0]!.notnull).toBe(false);
      const pk = await failure(adapter.previewChange(set("id", true, "s_keep")));
      expect([pk.code, pk.message]).toEqual([
        "invalid_change",
        expect.stringContaining("primary key"),
      ]);
    });

    it("sets and drops a default from the fixed list", async () => {
      const set = (column: string, value: ColumnDefault): Change => ({
        kind: "set_default",
        table: ref("s_alter"),
        column,
        default: value,
      });
      const literal = await apply(set("label", { kind: "literal", value: `o'k \\` }));
      expect(statementText(literal)).toBe(
        `ALTER TABLE "public"."s_alter" ALTER COLUMN "label" SET DEFAULT CAST(E'o''k \\\\' AS text);`,
      );
      await apply(set("big", { kind: "literal", value: "42" }));
      await sql.query("INSERT INTO s_alter (id, n) VALUES ('3', 3)");
      expect(await rows("SELECT label, big::text FROM s_alter WHERE id = '3'")).toEqual([
        { label: `o'k \\`, big: "42" },
      ]);
      const drop = await apply(set("label", { kind: "none" }));
      expect(statementText(drop)).toBe(
        'ALTER TABLE "public"."s_alter" ALTER COLUMN "label" DROP DEFAULT;',
      );
      expect((await columnsOf("s_alter")).find((c) => c.name === "label")?.def).toBeNull();

      const refuse = async (change: Change, code: string) =>
        expect((await failure(adapter.previewChange(change))).code).toBe(code);
      await refuse(set("big", { kind: "literal", value: SECRET }), "invalid_value");
      await refuse(set("big", { kind: "now" }), "invalid_change");
      await refuse(set("arr", { kind: "boolean", value: true }), "invalid_change");
      await refuse(set("seq", { kind: "literal", value: "1" }), "invalid_change"); // identity
      await refuse(set("label", { kind: "literal", value: "a\0b" }), "invalid_change");
    });
  });

  describe("keys, constraints and indexes", () => {
    it("adds a primary key and a unique key, and refuses duplicates without showing them", async () => {
      const dup = await failure(
        adapter.applyChange(
          await adapter.previewChange({
            kind: "add_unique",
            table: ref("s_nopk"),
            columns: ["dup"],
          }),
        ),
        "7",
      );
      expect(dup.code).toBe("unique_violation");
      const unique = await apply({ kind: "add_unique", table: ref("s_nopk"), columns: ["a", "b"] });
      expect(statementText(unique)).toBe('ALTER TABLE "public"."s_nopk" ADD UNIQUE ("a", "b");');
      const pk = await apply({ kind: "add_primary_key", table: ref("s_nopk"), columns: ["a"] });
      expect(statementText(pk)).toBe('ALTER TABLE "public"."s_nopk" ADD PRIMARY KEY ("a");');
      expect(pk.warnings.map((w) => w.code)).toEqual(["lock", "scan", "may_fail"]);
      expect(await adapter.describeForEdit(ref("s_nopk"))).toMatchObject({
        editable: true,
        key: ["a"],
      });
      const second = await failure(
        adapter.previewChange({ kind: "add_primary_key", table: ref("s_nopk"), columns: ["b"] }),
      );
      expect([second.code, second.message]).toEqual([
        "invalid_change",
        expect.stringContaining("already has a primary key"),
      ]);
      const twice = await failure(
        adapter.previewChange({ kind: "add_unique", table: ref("s_nopk"), columns: ["a", "a"] }),
      );
      expect(twice.code).toBe("invalid_change");
    });

    it("adds a foreign key, and refuses one that existing rows break", async () => {
      const fk = (columns: string[], target: string[]): Change => ({
        kind: "add_foreign_key",
        table: ref("s_child"),
        foreignKey: {
          columns,
          references: { schema: "public", table: "s_keep", columns: target },
          onDelete: "set_null",
          onUpdate: "cascade",
        },
      });
      const broken = await failure(
        adapter.applyChange(await adapter.previewChange(fk(["orphan"], ["id"]))),
        "999",
      );
      expect(broken.code).toBe("foreign_key_violation");
      await sql.query("UPDATE s_child SET orphan = 2");
      const plan = await apply(fk(["orphan"], ["id"]));
      expect(statementText(plan)).toBe(
        'ALTER TABLE "public"."s_child" ADD FOREIGN KEY ("orphan") REFERENCES "public"."s_keep" ("id") ON DELETE SET NULL ON UPDATE CASCADE;',
      );
      expect(plan.warnings.map((w) => w.code)).toEqual(["lock", "scan", "may_fail"]);
      const notUnique = await failure(adapter.previewChange(fk(["orphan"], ["plain"])));
      expect(notUnique.code).toBe("invalid_change");
    });

    it("drops a constraint, but not one that foreign keys rely on", async () => {
      const drop = (table: string, constraint: string): Change => ({
        kind: "drop_constraint",
        table: ref(table),
        constraint,
      });
      const plan = await apply(drop("s_child", "s_child_orphan_fkey"));
      expect(statementText(plan)).toBe(
        'ALTER TABLE "public"."s_child" DROP CONSTRAINT "s_child_orphan_fkey";',
      );
      expect(plan.destructive).toBe(true);
      const relied = await failure(adapter.previewChange(drop("s_keep", "s_keep_pkey")));
      expect(relied.code).toBe("has_dependents");
      expect(relied.message).toContain("public.s_alter: s_alter_linked_fkey");
      expect((await failure(adapter.previewChange(drop("s_keep", "nope")))).code).toBe(
        "invalid_change",
      );
      await sql.query("ALTER TABLE s_nopk ADD CONSTRAINT s_nopk_check CHECK (b > 0)");
      expect((await failure(adapter.previewChange(drop("s_nopk", "s_nopk_check")))).code).toBe(
        "invalid_change",
      );
      // A unique constraint nothing relies on goes.
      await apply(drop("s_nopk", "s_nopk_a_b_key"));
    });

    it("creates a plain index and drops it, but not an index that enforces a constraint", async () => {
      const plan = await apply({
        kind: "create_index",
        table: ref("s_alter"),
        columns: ["label", "free"],
        unique: false,
      });
      expect(statementText(plan)).toBe('CREATE INDEX ON "public"."s_alter" ("label", "free");');
      expect(plan.warnings.map((w) => w.code)).toEqual(["lock", "scan"]);
      expect(plan.statements[0]!.text).not.toContain("CONCURRENTLY");
      const unique = await apply({
        kind: "create_index",
        table: ref("s_alter"),
        columns: ["free"],
        unique: true,
      });
      expect(statementText(unique)).toBe('CREATE UNIQUE INDEX ON "public"."s_alter" ("free");');
      const names = (await adapter.getIndexes("public", "s_alter")).map((i) => i.name);
      expect(names).toEqual(expect.arrayContaining(["s_alter_label_free_idx", "s_alter_free_idx"]));

      const drop = (table: string, index: string): Change => ({
        kind: "drop_index",
        table: ref(table),
        index,
      });
      const dropped = await apply(drop("s_alter", "s_alter_label_free_idx"));
      expect(statementText(dropped)).toBe('DROP INDEX "public"."s_alter_label_free_idx";');
      expect(dropped.destructive).toBe(true);
      const backing = await failure(adapter.previewChange(drop("s_keep", "s_keep_pkey")));
      expect([backing.code, backing.message]).toEqual([
        "invalid_change",
        expect.stringContaining("drop the constraint instead"),
      ]);
      expect((await failure(adapter.previewChange(drop("s_alter", "nope")))).code).toBe(
        "invalid_change",
      );
      // An index of another table is not this table's.
      expect((await failure(adapter.previewChange(drop("s_keep", "s_alter_free_idx")))).code).toBe(
        "invalid_change",
      );
    });
  });

  describe("drops", () => {
    const dropColumn = (column: string, confirm = "s_alter"): Change => ({
      kind: "drop_column",
      table: ref("s_alter"),
      column,
      confirm,
    });
    const dropTable = (table: string, confirm = table): Change => ({
      kind: "drop_table",
      table: ref(table),
      confirm,
    });

    it("needs the table's name typed exactly", async () => {
      for (const change of [
        dropColumn("free", "S_ALTER"),
        dropColumn("free", ""),
        dropTable("s_drop_plain", "s_drop_plain "),
      ]) {
        const error = await failure(adapter.previewChange(change));
        expect([error.code, error.message]).toEqual([
          "invalid_change",
          expect.stringContaining("exactly"),
        ]);
      }
    });

    it("refuses to drop a column that a view, an index or a foreign key uses, and names them", async () => {
      const refused = async (column: string, word: string) => {
        const error = await failure(adapter.previewChange(dropColumn(column)));
        expect([error.code, error.message]).toEqual([
          "has_dependents",
          expect.stringContaining(word),
        ]);
      };
      await refused("viewed", "view public.s_alter_view");
      await refused("indexed", "s_alter_indexed_idx");
      await refused("linked", "s_alter_linked_fkey"); // its own foreign key
      await refused("id", "s_child_parent_fkey"); // another table points at it
      await refused("n", "s_alter_n_uq");
      expect((await failure(adapter.previewChange(dropColumn("nope")))).code).toBe(
        "invalid_change",
      );
      expect((await columnsOf("s_alter")).map((c) => c.name)).toContain("viewed");
    });

    it("drops a column nothing uses, and one that only owns a sequence", async () => {
      await sql.query("DROP INDEX s_alter_free_idx");
      const plan = await apply(dropColumn("free"));
      expect(statementText(plan)).toBe('ALTER TABLE "public"."s_alter" DROP COLUMN "free";');
      expect(plan.destructive).toBe(true);
      expect(plan.warnings.map((w) => w.code)).toEqual(["lock", "destructive"]);
      await apply(dropColumn("counter")); // a serial column: its sequence and default go with it
      const names = (await columnsOf("s_alter")).map((c) => c.name);
      expect(names).not.toContain("free");
      expect(names).not.toContain("counter");
    });

    it("refuses to drop a table that a view or another table's foreign key uses", async () => {
      const viewed = await failure(adapter.previewChange(dropTable("s_drop_viewed")));
      expect([viewed.code, viewed.message]).toEqual([
        "has_dependents",
        expect.stringContaining("view public.s_drop_view"),
      ]);
      const referenced = await failure(adapter.previewChange(dropTable("s_drop_referenced")));
      expect([referenced.code, referenced.message]).toEqual([
        "has_dependents",
        expect.stringContaining("s_drop_referrer_r_fkey"),
      ]);
      expect((await failure(adapter.previewChange(dropTable("nope")))).code).toBe("not_found");
      expect((await failure(adapter.previewChange(dropTable("s_view")))).code).toBe("not_editable");
      expect(await exists("s_drop_viewed")).toBe(true);
      expect(await exists("s_drop_referenced")).toBe(true);
    });

    it("drops a table nothing else uses, its own keys, indexes and self-reference included", async () => {
      const plan = await apply(dropTable("s_drop_plain"));
      expect(statementText(plan)).toBe('DROP TABLE "public"."s_drop_plain";');
      expect(plan.destructive).toBe(true);
      await apply(dropTable("s_drop_self"));
      await apply(dropTable("s_drop_referrer")); // the referrer itself can go
      await apply(dropTable("s_drop_referenced")); // ...and then what it pointed at
      for (const name of ["s_drop_plain", "s_drop_self", "s_drop_referrer", "s_drop_referenced"]) {
        expect(await exists(name)).toBe(false);
      }
    });

    it("a dependent that appears after the preview still stops the drop: the database refuses, no CASCADE", async () => {
      await sql.query("CREATE TABLE s_late (id int PRIMARY KEY)");
      const plan = await adapter.previewChange(dropTable("s_late"));
      await sql.query("CREATE VIEW s_late_view AS SELECT id FROM s_late");
      expect(statementText(plan)).not.toMatch(/cascade/i);
      expect((await failure(adapter.applyChange(plan))).code).toBe("has_dependents");
      expect(await exists("s_late")).toBe(true);
    });
  });

  describe("locks and transactions", () => {
    it("a change of structure fails fast behind another session's lock", async () => {
      const { host, port, username, password } = db.connection;
      const blocker = new pg.Client({ host, port, user: username, password, database: db.dbName });
      await blocker.connect();
      const plan = await adapter.previewChange({
        kind: "add_column",
        table: ref("s_keep"),
        column: col("late", "text"),
      });
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT * FROM s_keep"); // an open read is enough to block ALTER TABLE
        const started = Date.now();
        expect((await failure(adapter.applyChange(plan))).code).toBe("locked");
        expect(Date.now() - started).toBeLessThan(8000);
      } finally {
        await blocker.query("ROLLBACK");
        await blocker.end();
      }
      expect((await columnsOf("s_keep")).map((c) => c.name)).not.toContain("late");
    }, 20_000);

    it("rolls back every statement of a change when a later one fails", async () => {
      const plan = await adapter.previewChange(
        create("s_atomic", [col("a", "integer", { comment: "c" })], {
          comment: "t",
        } as Partial<CreateTableChange>),
      );
      expect(plan.statements).toHaveLength(3);
      const broken: PlannedChange = {
        ...plan,
        statements: [
          ...plan.statements,
          { text: 'COMMENT ON TABLE "public"."nope" IS \'x\'', values: [] },
        ],
      };
      expect((await failure(adapter.applyChange(broken))).code).toBe("not_found");
      expect(await exists("s_atomic")).toBe(false);
    });
  });

  describe("what is not offered", () => {
    it("refuses a kind of change that is not on the list, whatever it carries", async () => {
      for (const change of [
        { kind: "run_sql", sql: "DROP TABLE s_keep" },
        { kind: "truncate_table", table: ref("s_keep") },
        { kind: "__proto__", table: ref("s_keep") },
        { kind: "toString", table: ref("s_keep") },
      ]) {
        const error = await failure(adapter.previewChange(change as unknown as Change));
        expect([error.code, error.message]).toEqual([
          "invalid_change",
          "This kind of change is not offered.",
        ]);
      }
      expect(await exists("s_keep")).toBe(true);
    });

    it("no statement previewed in this file says CASCADE outside a foreign key's own action", () => {
      expect(previewed.length).toBeGreaterThan(40);
      for (const text of previewed) {
        expect(text.replace(/ON (DELETE|UPDATE) CASCADE/g, "")).not.toMatch(/cascade/i);
        expect(text).not.toMatch(/CONCURRENTLY|\bUSING\b/);
      }
    });
  });
});
