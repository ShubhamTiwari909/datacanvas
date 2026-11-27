/**
 * Imports by key against a real PostgreSQL (`docs/write-side-v2-plan.md`, 4.1, 4.2 and 13): update or insert
 * (`upsert_rows`, the import batch with `ON CONFLICT (key)`) and update only (`update_by_key`, `UPDATE ... FROM
 * unnest`). The key is re-derived from the catalog at preview; the preview counts the rows that exist; every batch
 * must report exactly the rows it was planned for, or nothing is kept. No value reaches a preview, an error or the
 * history.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database; a throwaway role is created
 * (and dropped) for the role that may not read the table.
 */
import {
  DatabaseError,
  IMPORT_BATCH_ROWS,
  changeColumns,
  statementText,
  type Change,
  type PlannedChange,
  type TableRef,
} from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import {
  createTestDatabase,
  quoteIdent,
  testDatabaseUrl,
  type TestDatabase,
} from "./testing/index.js";

const SECRET = "hunter2-SECRET-VALUE";
const ODD_TABLE = 'u "odd" ; table';
const ODD_KEY_A = "select";
const ODD_KEY_B = 'a"b c';
const ODD_COLUMNS = [ODD_KEY_A, ODD_KEY_B, "c0", "ключ 🙂"];

const SQL = `
  CREATE TABLE u_items (
    id int PRIMARY KEY, code text NOT NULL UNIQUE, name varchar(10), qty int CHECK (qty >= 0), note text
  );
  CREATE TABLE u_pair (a int NOT NULL, b text NOT NULL, v text, PRIMARY KEY (b, a));
  CREATE TABLE u_keys (
    id int PRIMARY KEY, nul text UNIQUE, def text NOT NULL, part text NOT NULL, expr text NOT NULL, v text,
    CONSTRAINT u_keys_def_key UNIQUE (def) DEFERRABLE INITIALLY IMMEDIATE
  );
  CREATE UNIQUE INDEX u_keys_part_idx ON u_keys (part) WHERE v IS NOT NULL;
  CREATE UNIQUE INDEX u_keys_expr_idx ON u_keys (lower(expr));
  CREATE TABLE "u ""odd"" ; table" (
    "select" int NOT NULL, "a""b c" text NOT NULL, "c0" text, "ключ 🙂" text, PRIMARY KEY ("a""b c", "select")
  );
  CREATE TABLE excluded (x int PRIMARY KEY, c0 text);
  CREATE TABLE u_audit (what text);
  CREATE FUNCTION u_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO u_audit VALUES (TG_WHEN || ' ' || TG_OP); RETURN NEW; END $$;
  CREATE TABLE u_trig (id int PRIMARY KEY, v text);
  CREATE TRIGGER u_bi BEFORE INSERT ON u_trig FOR EACH ROW EXECUTE PROCEDURE u_audit_fn();
  CREATE TRIGGER u_ai AFTER INSERT ON u_trig FOR EACH ROW EXECUTE PROCEDURE u_audit_fn();
  CREATE TRIGGER u_bu BEFORE UPDATE ON u_trig FOR EACH ROW EXECUTE PROCEDURE u_audit_fn();
  CREATE TABLE u_part (id int NOT NULL, region text NOT NULL, v text, PRIMARY KEY (id, region))
    PARTITION BY LIST (region);
  CREATE TABLE u_part_eu PARTITION OF u_part FOR VALUES IN ('eu');
  CREATE TABLE u_part_us PARTITION OF u_part FOR VALUES IN ('us');
  CREATE TABLE u_ident (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text);
  CREATE TABLE u_grants (id int PRIMARY KEY, v text);
  CREATE TABLE u_nokey (v text);
  CREATE VIEW u_view AS SELECT id, note FROM u_items;
`;

type Rows = Array<Array<string | null>>;

describe.skipIf(!testDatabaseUrl())("PostgresAdapter import by key", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;
  let limited: PostgresAdapter;
  let sql: pg.Client;
  const role = `dc_upsert_${Math.random().toString(16).slice(2, 10)}`;
  const rolePassword = "role-pw-1";
  const ref = (name: string): TableRef => ({ schema: "public", name });
  const upsert = (
    table: string,
    key: string[],
    columns: string[],
    rows: Rows,
    updateColumns: string[],
  ): Change => ({ kind: "upsert_rows", table: ref(table), key, columns, rows, updateColumns });
  const byKey = (table: string, key: string[], columns: string[], rows: Rows): Change => ({
    kind: "update_by_key",
    table: ref(table),
    key,
    columns,
    rows,
  });
  const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> =>
    (await sql.query(text)).rows as T[];
  const count = async (table: string, where = "true"): Promise<number> =>
    Number((await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0]!.n);
  const items = (n: number, from = 1, tag = "new"): Rows =>
    Array.from({ length: n }, (_, i) => [
      String(from + i),
      `code-${from + i}`,
      `${tag}${(from + i) % 1000}`.slice(0, 10),
      String(i % 7),
    ]);
  const seedItems = async (n: number, from = 1) => {
    await sql.query("TRUNCATE u_items");
    await sql.query(
      `INSERT INTO u_items (id, code, name, qty, note)
       SELECT g, 'code-' || g, 'old', 1, 'old note' FROM generate_series(${from}, ${from + n - 1}) AS g`,
    );
  };

  /** The error a promise rejects with, checked to be a DatabaseError that never repeats the marker. */
  async function failure(work: Promise<unknown>): Promise<DatabaseError> {
    const error = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DatabaseError);
    const failed = error as DatabaseError;
    for (const text of [failed.message, JSON.stringify(failed), String(failed)]) {
      expect(text).not.toContain(SECRET);
    }
    return failed;
  }

  /** Everything of a plan that reaches the browser or the history: never a value. */
  function shown(plan: PlannedChange): string {
    return JSON.stringify({
      statement: statementText(plan),
      effect: plan.effect,
      warnings: plan.warnings,
      skipped: plan.skipped,
      counts: plan.counts,
      history: changeColumns(plan.change),
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    sql = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await sql.connect();
    await sql.query(SQL);
    await sql.query(`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD '${rolePassword}'`);
    await sql.query(`GRANT CONNECT ON DATABASE ${quoteIdent(db.dbName)} TO ${quoteIdent(role)}`);
    await sql.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(role)}`);
    // Every column may be read, but not the table as a whole: `xmax` (a system column) needs that (13.1, item 7).
    await sql.query(`GRANT SELECT (id, v), INSERT, UPDATE ON u_grants TO ${quoteIdent(role)}`);
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
    limited = new PostgresAdapter({ ...db.connection, username: role, password: rolePassword });
    await limited.connect();
  }, 60_000);

  afterAll(async () => {
    await limited?.disconnect();
    await adapter?.disconnect();
    await sql?.end().catch(() => {});
    await db?.dispose().catch(() => {});
    if (!db) return;
    const { host, port, username, password } = db.connection;
    const admin = new pg.Client({ host, port, user: username, password, database: "postgres" });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
    } finally {
      await admin.end();
    }
  });

  describe("the keys offered", () => {
    it("lists only the keys an import by key may use: not partial, not on expressions, not deferrable, NOT NULL", async () => {
      expect((await adapter.describeForEdit(ref("u_keys"))).uniqueKeys).toEqual([
        { name: "u_keys_pkey", columns: ["id"] },
      ]);
      expect((await adapter.describeForEdit(ref("u_items"))).uniqueKeys).toEqual([
        { name: "u_items_pkey", columns: ["id"] },
        { name: "u_items_code_key", columns: ["code"] },
      ]);
      // A composite key in its own order, and awkward names as they are.
      expect((await adapter.describeForEdit(ref("u_pair"))).uniqueKeys).toEqual([
        { name: "u_pair_pkey", columns: ["b", "a"] },
      ]);
      expect((await adapter.describeForEdit(ref(ODD_TABLE))).uniqueKeys?.[0]?.columns).toEqual([
        ODD_KEY_B,
        ODD_KEY_A,
      ]);
      expect((await adapter.describeForEdit(ref("u_part"))).uniqueKeys).toEqual([
        { name: "u_part_pkey", columns: ["id", "region"] },
      ]);
      // A view and a table without a key offer none.
      expect((await adapter.describeForEdit(ref("u_view"))).uniqueKeys).toEqual([]);
      expect((await adapter.describeForEdit(ref("u_nokey"))).uniqueKeys).toEqual([]);
    });

    it("refuses a key that is not one the table may use: nullable, deferrable, partial, expression, part of a key, no key", async () => {
      const refused = async (change: Change) => (await failure(adapter.previewChange(change))).code;
      // A nullable unique constraint, a deferrable one, a partial and an expression unique index, no key at all.
      const all = ["id", "nul", "def", "part", "expr", "v"];
      const row = [["1", "n", "d", "p", "e", "v"]];
      for (const key of ["nul", "def", "part", "expr", "v"]) {
        expect(await refused(upsert("u_keys", [key], all, row, [])), key).toBe("invalid_change");
        expect(await refused(byKey("u_keys", [key], all, row)), key).toBe("invalid_change");
      }
      // Part of a composite key infers nothing (42P10): refused at preview instead.
      expect(
        await refused(upsert("u_pair", ["a"], ["a", "b", "v"], [["1", "x", "v"]], ["v"])),
      ).toBe("invalid_change");
      // A key column that is not mapped, a column that does not exist, a view and a table without a key.
      expect(await refused(upsert("u_pair", ["a", "b"], ["a", "v"], [["1", "v"]], []))).toBe(
        "invalid_change",
      );
      expect(await refused(upsert("u_items", ["nope"], ["nope"], [["1"]], []))).toBe(
        "invalid_change",
      );
      expect(await refused(upsert("u_view", ["id"], ["id"], [["1"]], []))).toBe("not_editable");
      expect(await refused(upsert("u_nokey", ["v"], ["v"], [["1"]], []))).toBe("not_editable");
      // The planner says why, naming structure only.
      const deferrable = await failure(
        adapter.previewChange(
          upsert("u_keys", ["def"], ["id", "def", "part", "expr"], [["1", SECRET, "p", "e"]], []),
        ),
      );
      expect(deferrable.message).toContain("u_keys_def_key");
      expect(deferrable.message).toContain("not deferrable");
    });

    it("refuses columns to update that are the key, another unique key or the primary key, or not mapped", async () => {
      const refused = async (change: Change) => failure(adapter.previewChange(change));
      const row = [["1", "code-1", "n", "1"]];
      const columns = ["id", "code", "name", "qty"];
      // Keyed by the primary key, `code` (another unique constraint) cannot be updated.
      const other = await refused(upsert("u_items", ["id"], columns, row, ["name", "code"]));
      expect(other.code).toBe("invalid_change");
      expect(other.message).toContain("code is part of a unique key or of the primary key");
      // Keyed by `code`, the primary key `id` cannot be updated (that would move the row's key).
      expect((await refused(upsert("u_items", ["code"], columns, row, ["id"]))).code).toBe(
        "invalid_change",
      );
      // The key itself, and a column that is not mapped.
      expect((await refused(upsert("u_items", ["id"], columns, row, ["id"]))).code).toBe(
        "invalid_change",
      );
      expect((await refused(upsert("u_items", ["id"], columns, row, ["note"]))).code).toBe(
        "invalid_change",
      );
      // A column a partial or an expression unique index reads.
      const keyed = ["id", "part", "expr", "def", "v"];
      const keysRow = [["1", "p", "e", "d", "v"]];
      for (const column of ["part", "expr", "v", "def"]) {
        expect(
          (await refused(upsert("u_keys", ["id"], keyed, keysRow, [column]))).code,
          column,
        ).toBe("invalid_change");
      }
    });
  });

  describe("upsert_rows", () => {
    it("counts the rows that exist at preview, needs the tick, and updates and inserts across batches, counted row by row", async () => {
      await seedItems(600, 401);
      const rows = items(1200);
      const plan = await adapter.previewChange(
        upsert("u_items", ["id"], ["id", "code", "name", "qty"], rows, ["name", "qty"]),
      );
      expect(plan.counts).toEqual({ insert: 600, update: 600, unchanged: 0 });
      expect(plan.destructive).toBe(true);
      expect(plan.effect.split(". ")[0]).toContain(
        "Adds 600 new rows to public.u_items and updates 600 rows that already exist by u_items_pkey (id)",
      );
      expect(plan.effect).toContain("600 rows will be overwritten in name and qty");
      expect(plan.warnings.find((w) => w.code === "destructive")?.message).toContain(
        "600 rows will be overwritten",
      );
      expect(plan.statements.map((s) => s.expectRows)).toEqual([500, 500, 200]);
      expect(plan.statements.every((s) => s.countsInserted === true)).toBe(true);
      const text = statementText(plan);
      expect(text.match(/INSERT INTO/g)).toHaveLength(1);
      expect(text).toContain(
        'ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "qty" = EXCLUDED."qty"',
      );
      expect(text).toContain("RETURNING (dc_t.xmax = 0) AS inserted");

      const applied = await adapter.applyChange(plan);
      expect(applied).toEqual({
        rowCount: 1200,
        split: { inserted: 600, updated: 600, exact: true },
      });
      expect(await count("u_items")).toBe(1200);
      // Updated rows keep what was not updated (the note), and get the file's values in the columns updated.
      expect(
        await q(
          "SELECT id, code, name, qty, note FROM u_items WHERE id IN (1, 401, 1000, 1001) ORDER BY id",
        ),
      ).toEqual([
        { id: 1, code: "code-1", name: "new1", qty: 0, note: null },
        { id: 401, code: "code-401", name: "new401", qty: 1, note: "old note" },
        { id: 1000, code: "code-1000", name: "new0", qty: 5, note: "old note" },
        { id: 1001, code: "code-1001", name: "new1", qty: 6, note: null },
      ]);
    });

    it("is not destructive when no row exists yet, and counts every row as inserted", async () => {
      await sql.query("TRUNCATE u_items");
      const plan = await adapter.previewChange(
        upsert("u_items", ["id"], ["id", "code", "name", "qty"], items(3), ["name"]),
      );
      expect(plan.counts).toEqual({ insert: 3, update: 0, unchanged: 0 });
      expect(plan.destructive).toBe(false);
      expect(plan.warnings.some((w) => w.code === "destructive")).toBe(false);
      expect((await adapter.applyChange(plan)).split).toEqual({
        inserted: 3,
        updated: 0,
        exact: true,
      });
    });

    it("leaves existing rows alone with no column to update (DO NOTHING), each batch checked for its new rows", async () => {
      await seedItems(300, 451);
      const rows = items(1100);
      const plan = await adapter.previewChange(
        upsert("u_items", ["code"], ["id", "code", "name", "qty"], rows, []),
      );
      expect(plan.counts).toEqual({ insert: 800, update: 0, unchanged: 300 });
      expect(plan.destructive).toBe(false);
      // Batch 1 holds 451..500 (50 existing), batch 2 holds 501..750 (250 existing), batch 3 none.
      expect(plan.statements.map((s) => s.expectRows)).toEqual([450, 250, 100]);
      expect(statementText(plan)).toContain('ON CONFLICT ("code") DO NOTHING');
      expect(statementText(plan)).not.toContain("RETURNING");
      expect(plan.effect).toContain(
        "leaves the 300 rows that already exist by u_items_code_key (code) as they are",
      );
      const applied = await adapter.applyChange(plan);
      expect(applied).toEqual({ rowCount: 800, split: { inserted: 800, updated: 0, exact: true } });
      expect(await count("u_items", "name = 'old'")).toBe(300);
      expect(await count("u_items")).toBe(1100);
    });

    it("keys by a composite key given in any order", async () => {
      await sql.query("TRUNCATE u_pair");
      await sql.query("INSERT INTO u_pair VALUES (1, 'x', 'old'), (2, 'x', 'old')");
      const plan = await adapter.previewChange(
        upsert(
          "u_pair",
          ["a", "b"],
          ["v", "a", "b"],
          [
            ["new", "1", "x"],
            ["new", "1", "y"],
            ["new", "2", "x"],
          ],
          ["v"],
        ),
      );
      expect(plan.counts).toEqual({ insert: 1, update: 2, unchanged: 0 });
      // The conflict target is the constraint's own columns, from the catalog.
      expect(statementText(plan)).toContain('ON CONFLICT ("b", "a")');
      expect((await adapter.applyChange(plan)).split).toEqual({
        inserted: 1,
        updated: 2,
        exact: true,
      });
      expect(await q("SELECT a, b, v FROM u_pair ORDER BY a, b")).toEqual([
        { a: 1, b: "x", v: "new" },
        { a: 1, b: "y", v: "new" },
        { a: 2, b: "x", v: "new" },
      ]);
    });

    it("works with hostile names: quotes, spaces, reserved words, unicode, a table called excluded", async () => {
      await sql.query(`TRUNCATE ${quoteIdent(ODD_TABLE)}`);
      await sql.query(`INSERT INTO ${quoteIdent(ODD_TABLE)} VALUES (1, 'k', 'old', 'old')`);
      const change = upsert(
        ODD_TABLE,
        [ODD_KEY_A, ODD_KEY_B],
        ODD_COLUMNS,
        [
          ["1", "k", "new c0", "new ü"],
          ["2", "k", "c0 2", "ü 2"],
        ],
        ["c0", "ключ 🙂"],
      );
      const plan = await adapter.previewChange(change);
      expect(plan.counts).toEqual({ insert: 1, update: 1, unchanged: 0 });
      expect(await adapter.applyChange(plan)).toMatchObject({ rowCount: 2 });
      expect(await q(`SELECT * FROM ${quoteIdent(ODD_TABLE)} ORDER BY "select"`)).toEqual([
        { select: 1, 'a"b c': "k", c0: "new c0", "ключ 🙂": "new ü" },
        { select: 2, 'a"b c': "k", c0: "c0 2", "ключ 🙂": "ü 2" },
      ]);
      await sql.query("TRUNCATE excluded");
      await sql.query("INSERT INTO excluded VALUES (1, 'old')");
      const named = await adapter.previewChange(
        upsert(
          "excluded",
          ["x"],
          ["x", "c0"],
          [
            ["1", "a"],
            ["2", "b"],
          ],
          ["c0"],
        ),
      );
      expect((await adapter.applyChange(named)).split).toEqual({
        inserted: 1,
        updated: 1,
        exact: true,
      });
      expect(await q("SELECT x, c0 FROM excluded ORDER BY x")).toEqual([
        { x: 1, c0: "a" },
        { x: 2, c0: "b" },
      ]);
    });

    it("refuses two rows with the same key anywhere in the file, as the database compares them, naming row numbers only", async () => {
      await sql.query("TRUNCATE u_items");
      const rows = items(1200);
      // Row 3 has id 3; row 1,000 has id 03 (the same integer), in another batch, with the marker in every cell.
      rows[999] = ["03", `code-${SECRET}`, SECRET.slice(0, 10), "1"];
      const error = await failure(
        adapter.previewChange(
          upsert("u_items", ["id"], ["id", "code", "name", "qty"], rows, ["name"]),
        ),
      );
      expect(error.code).toBe("invalid_change");
      expect(error.message).toContain("rows 3 and 1,000");
      expect(error.message).not.toContain("03");
      const both = await failure(
        adapter.previewChange(byKey("u_items", ["id"], ["id", "code", "name", "qty"], rows)),
      );
      expect(both.message).toContain("rows 3 and 1,000");
    });

    it("refuses a row without a key, and a key value that does not fit its type, without the value", async () => {
      const rows = items(4);
      rows[2] = [null, "code-x", "n", "1"];
      const empty = await failure(
        adapter.previewChange(upsert("u_items", ["id"], ["id", "code", "name", "qty"], rows, [])),
      );
      expect(empty.code).toBe("invalid_change");
      expect(empty.message).toContain("row 3");
      rows[2] = [`x-${SECRET}`, "code-x", "n", "1"];
      const typed = await failure(
        adapter.previewChange(upsert("u_items", ["id"], ["id", "code", "name", "qty"], rows, [])),
      );
      expect(typed.code).toBe("invalid_value");
    });

    it("rolls everything back when a row appears between preview and apply (DO NOTHING: a batch is one row short)", async () => {
      await sql.query("TRUNCATE u_items");
      const plan = await adapter.previewChange(
        upsert("u_items", ["id"], ["id", "code", "name", "qty"], items(700), []),
      );
      await sql.query("INSERT INTO u_items (id, code) VALUES (650, 'code-650')");
      expect((await failure(adapter.applyChange(plan))).code).toBe("unexpected");
      expect(await count("u_items")).toBe(1);
    });

    it("names the triggers that run, and that insert triggers run before every row, the updated ones included", async () => {
      await sql.query("TRUNCATE u_trig, u_audit");
      await sql.query("INSERT INTO u_trig SELECT g, 'old' FROM generate_series(1, 4) AS g");
      await sql.query("TRUNCATE u_audit");
      const rows = Array.from({ length: 10 }, (_, i) => [String(i + 1), "new"]);
      const plan = await adapter.previewChange(upsert("u_trig", ["id"], ["id", "v"], rows, ["v"]));
      const message = plan.warnings.find((w) => w.code === "triggers")?.message ?? "";
      expect(message).toContain("u_ai, u_bi and u_bu");
      expect(message).toContain(
        "Triggers that run before each inserted row run for all 10 rows, the 4 rows that become updates included",
      );
      expect(message).toContain(
        "triggers that run after each inserted row only for the 6 new rows",
      );
      await adapter.applyChange(plan);
      // What the message says is what happened.
      expect(
        await q("SELECT what, count(*)::int AS n FROM u_audit GROUP BY what ORDER BY what"),
      ).toEqual([
        { what: "AFTER INSERT", n: 6 },
        { what: "BEFORE INSERT", n: 10 },
        { what: "BEFORE UPDATE", n: 4 },
      ]);
    });

    it("upserts into a partitioned table without RETURNING xmax, and gives the preview's split as an estimate", async () => {
      await sql.query("TRUNCATE u_part");
      await sql.query("INSERT INTO u_part VALUES (1, 'eu', 'old')");
      const plan = await adapter.previewChange(
        upsert(
          "u_part",
          ["id", "region"],
          ["id", "region", "v"],
          [
            ["1", "eu", "new"],
            ["2", "us", "new"],
          ],
          ["v"],
        ),
      );
      expect(statementText(plan)).not.toContain("RETURNING");
      expect(plan.effect).toContain("the result gives this preview's count as an estimate");
      expect(await adapter.applyChange(plan)).toEqual({
        rowCount: 2,
        split: { inserted: 1, updated: 1, exact: false },
      });
      expect(await q("SELECT id, region, v FROM u_part ORDER BY id")).toEqual([
        { id: 1, region: "eu", v: "new" },
        { id: 2, region: "us", v: "new" },
      ]);
    });

    it("upserts as a role that may read every column but not the table, without RETURNING xmax", async () => {
      await sql.query("TRUNCATE u_grants");
      await sql.query("INSERT INTO u_grants VALUES (1, 'old')");
      const plan = await limited.previewChange(
        upsert(
          "u_grants",
          ["id"],
          ["id", "v"],
          [
            ["1", "new"],
            ["2", "new"],
          ],
          ["v"],
        ),
      );
      expect(statementText(plan)).not.toContain("RETURNING");
      expect(plan.counts).toEqual({ insert: 1, update: 1, unchanged: 0 });
      expect(await limited.applyChange(plan)).toEqual({
        rowCount: 2,
        split: { inserted: 1, updated: 1, exact: false },
      });
      expect(await q("SELECT id, v FROM u_grants ORDER BY id")).toEqual([
        { id: 1, v: "new" },
        { id: 2, v: "new" },
      ]);
    });

    it("refuses a column the database fills, as an import does", async () => {
      expect(
        (
          await failure(
            adapter.previewChange(upsert("u_ident", ["id"], ["id", "v"], [["1", "a"]], ["v"])),
          )
        ).code,
      ).toBe("invalid_change");
    });

    it("stops between batches when it is cancelled, and nothing is kept", async () => {
      await seedItems(10);
      const plan = await adapter.previewChange(
        upsert("u_items", ["id"], ["id", "code", "name", "qty"], items(1600), ["name"]),
      );
      expect(plan.statements).toHaveLength(4);
      let looked = 0;
      const signal = {
        get aborted() {
          looked += 1;
          return looked > 3;
        },
      };
      await failure(adapter.applyChange(plan, signal));
      expect(await count("u_items")).toBe(10);
      expect(await count("u_items", "name = 'old'")).toBe(10);
    });

    it("puts no value in the preview, the history or an error", async () => {
      await seedItems(2);
      const marked = (n: number): Rows =>
        Array.from({ length: n }, (_, i) => [
          String(i + 1),
          `${SECRET}-${i}`,
          SECRET.slice(0, 10),
          "1",
        ]);
      const plan = await adapter.previewChange(
        upsert("u_items", ["id"], ["id", "code", "name", "qty"], marked(5), ["name"]),
      );
      expect(shown(plan)).not.toContain(SECRET);
      expect(shown(plan)).not.toContain(SECRET.slice(0, 10));
      // A failure at apply (a CHECK) holds no value either.
      const bad = marked(3);
      bad[1] = ["9", `${SECRET}-x`, SECRET.slice(0, 10), "-1"];
      await failure(
        adapter.applyChange(
          await adapter.previewChange(
            upsert("u_items", ["id"], ["id", "code", "name", "qty"], bad, ["name"]),
          ),
        ),
      );
    });
  });

  describe("update_by_key", () => {
    it("updates the rows the file's keys find, leaves out and counts the others, and needs the tick", async () => {
      await seedItems(600);
      const rows: Rows = Array.from({ length: 700 }, (_, i) => [
        String(i + 1),
        `fixed${i + 1}`.slice(0, 10),
        "3",
      ]);
      const plan = await adapter.previewChange(
        byKey("u_items", ["id"], ["id", "name", "qty"], rows),
      );
      expect(plan.destructive).toBe(true);
      expect(plan.counts).toEqual({ insert: 0, update: 600, unchanged: 0 });
      // Positions in the request (0-based), as for a bulk change: rows 601 to 700 of the file find nothing.
      expect(plan.skipped).toEqual(Array.from({ length: 100 }, (_, i) => 600 + i));
      expect(plan.effect).toContain(
        "Updates 600 rows of public.u_items, each found by u_items_pkey (id)",
      );
      expect(plan.effect).toContain(
        "100 rows of the file find no row by u_items_pkey and are left out",
      );
      expect(plan.statements.map((s) => s.expectRows)).toEqual([500, 100]);
      const text = statementText(plan);
      expect(text).toContain(
        'UPDATE "public"."u_items" AS dc_t SET "name" = CAST(x.c1 AS character varying), "qty" = CAST(x.c2 AS integer) FROM unnest($1::text[], $2::text[], $3::text[]) AS x(c0, c1, c2) WHERE dc_t."id" = CAST(x.c0 AS integer)',
      );
      expect(await adapter.applyChange(plan)).toEqual({
        rowCount: 600,
        split: { inserted: 0, updated: 600, exact: true },
      });
      expect(
        await q("SELECT id, code, name, qty, note FROM u_items WHERE id IN (1, 600) ORDER BY id"),
      ).toEqual([
        { id: 1, code: "code-1", name: "fixed1", qty: 3, note: "old note" },
        { id: 600, code: "code-600", name: "fixed600", qty: 3, note: "old note" },
      ]);
      expect(await count("u_items")).toBe(600);
    });

    it("refuses when no row of the file finds a row, with the row_changed error", async () => {
      await seedItems(2);
      const error = await failure(
        adapter.previewChange(
          byKey("u_items", ["id"], ["id", "name"], [["99", SECRET.slice(0, 10)]]),
        ),
      );
      expect(error.code).toBe("row_changed");
    });

    it("rolls everything back when a row is deleted between preview and apply (the batch is short)", async () => {
      await seedItems(700);
      const rows: Rows = Array.from({ length: 700 }, (_, i) => [String(i + 1), "changed"]);
      const plan = await adapter.previewChange(byKey("u_items", ["id"], ["id", "name"], rows));
      await sql.query("DELETE FROM u_items WHERE id = 650");
      expect((await failure(adapter.applyChange(plan))).code).toBe("row_changed");
      expect(await count("u_items", "name = 'changed'")).toBe(0);
    });

    it("works by a unique key that is not the primary key, by a composite key, and with hostile names", async () => {
      await seedItems(3);
      await adapter.applyChange(
        await adapter.previewChange(
          byKey(
            "u_items",
            ["code"],
            ["code", "note"],
            [
              ["code-1", "by code"],
              ["code-3", "by code"],
            ],
          ),
        ),
      );
      expect(await count("u_items", "note = 'by code'")).toBe(2);
      await sql.query(`TRUNCATE ${quoteIdent(ODD_TABLE)}`);
      await sql.query(
        `INSERT INTO ${quoteIdent(ODD_TABLE)} VALUES (1, 'k', 'old', 'old'), (2, 'k', 'old', 'old')`,
      );
      const plan = await adapter.previewChange(
        byKey(ODD_TABLE, [ODD_KEY_B, ODD_KEY_A], ODD_COLUMNS, [["2", "k", "new", "neu ü"]]),
      );
      expect(await adapter.applyChange(plan)).toMatchObject({ rowCount: 1 });
      expect(
        await q(
          `SELECT "select", c0, "ключ 🙂" AS u FROM ${quoteIdent(ODD_TABLE)} ORDER BY "select"`,
        ),
      ).toEqual([
        { select: 1, c0: "old", u: "old" },
        { select: 2, c0: "new", u: "neu ü" },
      ]);
      // A table called excluded, with a column called c0 (the name of the rows' own aliases).
      await sql.query("TRUNCATE excluded");
      await sql.query("INSERT INTO excluded VALUES (1, 'old')");
      await adapter.applyChange(
        await adapter.previewChange(byKey("excluded", ["x"], ["x", "c0"], [["1", "new"]])),
      );
      expect(await q("SELECT c0 FROM excluded")).toEqual([{ c0: "new" }]);
    });

    it("may find rows by a key the database fills, and refuses a file of key columns only", async () => {
      await sql.query("TRUNCATE u_ident RESTART IDENTITY");
      await sql.query("INSERT INTO u_ident (v) VALUES ('old'), ('old')");
      await adapter.applyChange(
        await adapter.previewChange(byKey("u_ident", ["id"], ["id", "v"], [["2", "new"]])),
      );
      expect(await q("SELECT id, v FROM u_ident ORDER BY id")).toEqual([
        { id: 1, v: "old" },
        { id: 2, v: "new" },
      ]);
      expect(
        (await failure(adapter.previewChange(byKey("u_ident", ["id"], ["id"], [["1"]])))).code,
      ).toBe("invalid_change");
    });

    it("puts no value in the preview, the history or an error", async () => {
      await seedItems(3);
      const rows: Rows = [
        ["1", SECRET.slice(0, 10), "1"],
        ["99", SECRET.slice(0, 10), "1"],
      ];
      const plan = await adapter.previewChange(
        byKey("u_items", ["id"], ["id", "name", "qty"], rows),
      );
      expect(plan.skipped).toEqual([1]);
      expect(shown(plan)).not.toContain(SECRET.slice(0, 10));
      const bad: Rows = [["1", "x", `${SECRET}`]];
      expect(
        (
          await failure(
            adapter.applyChange(
              await adapter.previewChange(byKey("u_items", ["id"], ["id", "name", "qty"], bad)),
            ),
          )
        ).code,
      ).toBe("invalid_value");
    });

    it("updates 100,000 rows by key in one transaction", async () => {
      await sql.query("TRUNCATE u_items");
      await sql.query(
        "INSERT INTO u_items (id, code, name, qty) SELECT g, 'code-' || g, 'old', 1 FROM generate_series(1, 100000) AS g",
      );
      const rows: Rows = Array.from({ length: 100_000 }, (_, i) => [
        String(i + 1),
        "bulk",
        String(i % 9),
      ]);
      const started = Date.now();
      const plan = await adapter.previewChange(
        byKey("u_items", ["id"], ["id", "name", "qty"], rows),
      );
      expect(plan.statements).toHaveLength(100_000 / IMPORT_BATCH_ROWS);
      expect((await adapter.applyChange(plan)).rowCount).toBe(100_000);
      expect(await count("u_items", "name = 'bulk'")).toBe(100_000);
      console.log(`update by key of 100000 rows: ${Date.now() - started} ms, preview included`);
    }, 180_000);
  });
});
