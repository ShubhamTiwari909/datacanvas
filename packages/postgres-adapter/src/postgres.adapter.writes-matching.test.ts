/**
 * A change of the rows a filter matches against a real PostgreSQL (`docs/write-side-v2-plan.md`, section 6 and 13;
 * milestone E3): `update_matching` and `delete_matching`. The filter is used only by the preview's READ, which finds
 * the keys of the matching rows (at most 100,000, at most 8,000,000 characters of key text) and holds them in the
 * plan; apply writes those keys in keyed batches of 500, each checked to touch exactly the rows it carries, in one
 * transaction. An empty filter is refused; the count is typed to confirm (checked by the write service; the plan
 * carries it); a row gone since the preview rolls everything back; a row that stopped or started matching does not
 * change which rows are written. No value reaches a preview, an error, the history or a log.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import {
  DatabaseError,
  IMPORT_BATCH_ROWS,
  MATCHING_MAX_KEY_CHARS,
  MATCHING_MAX_KEY_VALUE_CHARS,
  MATCHING_MAX_ROWS,
  changeColumns,
  statementText,
  type Change,
  type PlannedChange,
  type RowFilter,
  type TableRef,
} from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withReadOnlyTransaction } from "./connection/read-only.js";
import { FILTER_REFUSED, FILTER_VALUE_REFUSED } from "./introspection/matching-keys.js";
import { PostgresAdapter } from "./postgres.adapter.js";
import {
  createTestDatabase,
  quoteIdent,
  testDatabaseUrl,
  type TestDatabase,
} from "./testing/index.js";
import {
  EMPTY_FILTER,
  MATCHING_ROW_GONE,
  planDeleteMatching,
  planUpdateMatching,
} from "./writes/matching.js";

const SECRET = "hunter2-SECRET-VALUE";
/** The console as it is before a test replaces it: the measured times are printed with it. */
const print = console.info.bind(console);
const ODD_TABLE = 'm "odd" ; table';
const LONG = MATCHING_MAX_KEY_VALUE_CHARS;
/** Keys of `LONG` characters that fit the cap of key text, and one more that does not. */
const FITS = Math.floor(MATCHING_MAX_KEY_CHARS / LONG);

const SQL = `
  CREATE TABLE m_items (
    id int PRIMARY KEY,
    name varchar(10),
    qty int CHECK (qty >= 0),
    note text,
    api_token text,
    code text UNIQUE,
    gen int GENERATED ALWAYS AS (qty * 2) STORED,
    seq int GENERATED ALWAYS AS IDENTITY,
    blob bytea
  );
  CREATE TABLE m_pair (a int NOT NULL, b text NOT NULL, v text, PRIMARY KEY (b, a));
  CREATE TABLE "m ""odd"" ; table" (
    "select" int NOT NULL, "a""b c" text NOT NULL, "c0" text, "ключ 🙂" text, PRIMARY KEY ("a""b c", "select")
  );
  CREATE TABLE m_parent (id int PRIMARY KEY, tag text);
  CREATE TABLE m_child (id int PRIMARY KEY, parent int CONSTRAINT m_child_parent_fkey REFERENCES m_parent (id));
  CREATE TABLE m_big (id int PRIMARY KEY, grp int NOT NULL);
  CREATE TABLE m_long (k text PRIMARY KEY, grp int NOT NULL);
  CREATE TABLE m_nokey (v text);
  CREATE VIEW m_view AS SELECT id, note FROM m_items;
  CREATE TABLE m_audit (what text);
  CREATE FUNCTION m_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO m_audit VALUES (TG_OP); RETURN NEW; END $$;
  CREATE TABLE m_trig (id int PRIMARY KEY, v text);
  CREATE TRIGGER m_bu BEFORE UPDATE ON m_trig FOR EACH ROW EXECUTE PROCEDURE m_audit_fn();
`;

describe.skipIf(!testDatabaseUrl())("PostgresAdapter change of the rows a filter matches", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;
  let sql: pg.Client;
  let pool: pg.Pool;
  const ref = (name: string): TableRef => ({ schema: "public", name });
  const update = (
    table: string,
    filters: RowFilter[],
    column: string,
    value: string | null,
    revealColumns: string[] = [],
  ): Change => ({
    kind: "update_matching",
    table: ref(table),
    filters,
    revealColumns,
    set: { column, value },
  });
  const remove = (table: string, filters: RowFilter[], revealColumns: string[] = []): Change => ({
    kind: "delete_matching",
    table: ref(table),
    filters,
    revealColumns,
  });
  const eq = (column: string, value: string, group?: number): RowFilter => ({
    column,
    op: "eq",
    value,
    ...(group === undefined ? {} : { group }),
  });
  const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> =>
    (await sql.query(text)).rows as T[];
  const count = async (table: string, where = "true"): Promise<number> =>
    Number((await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0]!.n);
  /** `n` rows: even ids have note 'even', odd ids 'odd'; name 'old', qty 1. */
  const seedItems = async (n: number) => {
    await sql.query("TRUNCATE m_items");
    await sql.query(
      `INSERT INTO m_items (id, name, qty, note, api_token, code)
       SELECT g, 'old', 1, CASE WHEN g % 2 = 0 THEN 'even' ELSE 'odd' END, 'tok-' || g, 'code-' || g
       FROM generate_series(1, ${n}) AS g`,
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

  /** Everything of a plan that reaches the browser or the history: never a value, never a key. */
  function shown(plan: PlannedChange): string {
    return JSON.stringify({
      statement: statementText(plan),
      effect: plan.effect,
      warnings: plan.warnings,
      skipped: plan.skipped,
      counts: plan.counts,
      confirmRows: plan.confirmRows,
      history: changeColumns(plan.change),
    });
  }

  let logged: unknown[][];
  beforeEach(() => {
    logged = [];
    for (const method of ["error", "warn", "log", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
    }
  });
  afterEach(() => {
    // Nothing of the write path writes to the console, and never a value.
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    vi.restoreAllMocks();
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    sql = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await sql.connect();
    await sql.query(SQL);
    await sql.query(
      `INSERT INTO m_big (id, grp) SELECT g, CASE WHEN g <= ${MATCHING_MAX_ROWS} THEN 1 ELSE 2 END
       FROM generate_series(1, ${MATCHING_MAX_ROWS + 1}) AS g`,
    );
    // Keys of exactly LONG characters (they compress, so the index takes them), FITS of them in group 1; one more in
    // group 2; and one key one character too long in group 3.
    await sql.query(
      `INSERT INTO m_long (k, grp)
       SELECT repeat('k', ${LONG - 6}) || lpad(g::text, 6, '0'), CASE WHEN g <= ${FITS} THEN 1 ELSE 2 END
       FROM generate_series(1, ${FITS + 1}) AS g`,
    );
    await sql.query(`INSERT INTO m_long (k, grp) VALUES (repeat('z', ${LONG + 1}), 3)`);
    await sql.query("ANALYZE m_big; ANALYZE m_long");
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
    pool = new pg.Pool({ host, port, user: username, password, database: db.dbName, max: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adapter?.disconnect();
    await sql?.end().catch(() => {});
    await db?.dispose().catch(() => {});
  });

  describe("update_matching", () => {
    it("finds the keys at preview, says only the count, needs the tick, and sets the value on exactly those rows", async () => {
      await seedItems(2400);
      const plan = await adapter.previewChange(
        update("m_items", [eq("note", "even")], "name", "fixed"),
      );
      expect(plan.destructive).toBe(true);
      expect(plan.confirmRows).toBe(1200);
      expect(plan.expect).toBe("any");
      expect(plan.statements.map((s) => s.expectRows)).toEqual([500, 500, 200]);
      // The keys, ordered by the key, held as the batches bind them: one array of text per key column, then the value.
      expect(plan.statements[0]!.values).toHaveLength(2);
      expect((plan.statements[0]!.values[0] as string[]).slice(0, 3)).toEqual(["2", "4", "6"]);
      expect(plan.statements[0]!.values[1]).toBe("fixed");
      expect(plan.statements[2]!.values[0]).toHaveLength(200);
      expect(statementText(plan)).toBe(
        'UPDATE "public"."m_items" AS dc_t SET "name" = CAST($2 AS character varying) FROM unnest($1::text[]) AS x(c0) WHERE dc_t."id" = CAST(x.c0 AS integer);\n' +
          "-- the same statement runs for each of 3 batches of up to 500 rows (the values differ)",
      );
      expect(plan.effect).toBe(
        "Sets name on the 1,200 rows of public.m_items that match the filter now. Rows are found by their key (id) when you apply: a row that matches the filter only after this preview is not changed. 3 batches, all in one transaction: every row is changed or none is.",
      );
      const destructive = plan.warnings.find((w) => w.code === "destructive")!.message;
      expect(destructive).toContain("1,200 rows will be overwritten");
      expect(destructive).toContain(
        "The rows were chosen by the filter, and are changed even if they changed since",
      );
      expect(changeColumns(plan.change)).toEqual(["name"]);
      // Nothing was changed by the preview.
      expect(await count("m_items", "name = 'old'")).toBe(2400);

      expect(await adapter.applyChange(plan)).toEqual({ rowCount: 1200 });
      expect(await count("m_items", "name = 'fixed'")).toBe(1200);
      expect(await count("m_items", "name = 'fixed' AND id % 2 = 1")).toBe(0);
      expect(await count("m_items", "name = 'old'")).toBe(1200);
    });

    it("takes the page reader's whole filter: several conditions, a group of alternatives, a revealed column, NULL as the value", async () => {
      await seedItems(20);
      const plan = await adapter.previewChange(
        update(
          "m_items",
          [
            { column: "qty", op: "eq", value: "1" },
            eq("note", "odd", 1),
            eq("api_token", "tok-4", 1),
          ],
          "note",
          null,
          ["api_token"],
        ),
      );
      expect(plan.confirmRows).toBe(11);
      await adapter.applyChange(plan);
      expect(await count("m_items", "note IS NULL")).toBe(11);
      expect(await count("m_items", "note IS NULL AND (id % 2 = 1 OR id = 4)")).toBe(11);
    });

    it("refuses an empty filter, with a fixed sentence, before anything is read", async () => {
      await seedItems(3);
      const error = await failure(adapter.previewChange(update("m_items", [], "name", "x")));
      expect(error).toMatchObject({ code: "invalid_change", message: EMPTY_FILTER });
    });

    it("refuses a filter on a hidden column, an unknown column or an operator the column does not allow", async () => {
      await seedItems(3);
      for (const filters of [
        [eq("api_token", SECRET)],
        [eq("nope", "1")],
        [{ column: "qty", op: "contains", value: "1" } as RowFilter],
        [{ column: "blob", op: "eq", value: "1" } as RowFilter],
      ]) {
        const error = await failure(adapter.previewChange(update("m_items", filters, "name", "x")));
        expect(error).toMatchObject({ code: "invalid_change", message: FILTER_REFUSED });
      }
    });

    it("refuses a value of the filter that does not fit its column, without the value", async () => {
      await seedItems(3);
      for (const filter of [
        eq("qty", SECRET),
        { column: "note", op: "matches", value: `(${SECRET}` } as RowFilter,
      ]) {
        const error = await failure(
          adapter.previewChange(update("m_items", [filter], "name", "x")),
        );
        expect(error).toMatchObject({ code: "invalid_change", message: FILTER_VALUE_REFUSED });
      }
    });

    it("refuses to set the key, a hidden, generated, identity or binary column, or one that does not exist", async () => {
      await seedItems(3);
      const filters = [eq("note", "odd")];
      for (const column of ["id", "api_token", "gen", "seq", "blob", "nope"]) {
        const error = await failure(adapter.previewChange(update("m_items", filters, column, "1")));
        expect([column, error.code]).toEqual([column, "invalid_change"]);
      }
      // A hidden column the person revealed may be set.
      const plan = await adapter.previewChange(
        update("m_items", filters, "api_token", "new", ["api_token"]),
      );
      expect(plan.confirmRows).toBe(2);
    });

    it("checks the value against the column at preview, without the value", async () => {
      await seedItems(3);
      const filters = [eq("note", "odd")];
      expect(
        (await failure(adapter.previewChange(update("m_items", filters, "qty", SECRET)))).code,
      ).toBe("invalid_value");
      expect(
        (await failure(adapter.previewChange(update("m_items", filters, "name", `${SECRET}-long`))))
          .code,
      ).toBe("invalid_value");
      // A rule of the table refuses at apply, with a fixed sentence, and nothing is kept.
      const plan = await adapter.previewChange(update("m_items", filters, "qty", "-1"));
      expect((await failure(adapter.applyChange(plan))).code).toBe("check_violation");
      expect(await count("m_items", "qty = 1")).toBe(3);
    });

    it("refuses a table without a key and a view; and a filter that matches nothing", async () => {
      await seedItems(3);
      for (const table of ["m_nokey", "m_view"]) {
        const filters = [eq(table === "m_nokey" ? "v" : "note", "x")];
        const column = table === "m_nokey" ? "v" : "note";
        expect(
          (await failure(adapter.previewChange(update(table, filters, column, "y")))).code,
        ).toBe("not_editable");
      }
      const error = await failure(
        adapter.previewChange(update("m_items", [eq("note", "none")], "name", "x")),
      );
      expect(error).toMatchObject({
        code: "invalid_change",
        message: "No row matches this filter now, so nothing would change.",
      });
    });

    it("works by a composite key and with hostile names (quotes, spaces, a reserved word, unicode, a column c0)", async () => {
      await sql.query("TRUNCATE m_pair");
      await sql.query(
        "INSERT INTO m_pair SELECT g % 3, 'b' || (g % 7), 'old' FROM generate_series(1, 21) AS g",
      );
      const pair = await adapter.previewChange(update("m_pair", [eq("v", "old")], "v", "new"));
      expect(pair.confirmRows).toBe(21);
      expect(statementText(pair)).toBe(
        'UPDATE "public"."m_pair" AS dc_t SET "v" = CAST($3 AS text) FROM unnest($1::text[], $2::text[]) AS x(c0, c1) WHERE dc_t."b" = CAST(x.c0 AS text) AND dc_t."a" = CAST(x.c1 AS integer);',
      );
      await adapter.applyChange(pair);
      expect(await count("m_pair", "v = 'new'")).toBe(21);

      const odd = quoteIdent(ODD_TABLE);
      await sql.query(`TRUNCATE ${odd}`);
      await sql.query(
        `INSERT INTO ${odd} VALUES (1, 'k', 'x', 'old'), (2, 'k', 'y', 'old'), (3, 'k''"', 'x', 'old')`,
      );
      const plan = await adapter.previewChange(
        update(ODD_TABLE, [eq("c0", "x")], "ключ 🙂", "neu ü"),
      );
      expect(plan.confirmRows).toBe(2);
      expect(statementText(plan)).toContain(
        `UPDATE "public"."m ""odd"" ; table" AS dc_t SET "ключ 🙂" = CAST($3 AS text) FROM unnest($1::text[], $2::text[]) AS x(c0, c1) WHERE dc_t."a""b c" = CAST(x.c0 AS text) AND dc_t."select" = CAST(x.c1 AS integer)`,
      );
      await adapter.applyChange(plan);
      expect(await q(`SELECT "select" AS s, "ключ 🙂" AS u FROM ${odd} ORDER BY 1`)).toEqual([
        { s: 1, u: "neu ü" },
        { s: 2, u: "old" },
        { s: 3, u: "neu ü" },
      ]);
    });

    it("rolls everything back when a row is deleted, or its key changed, between preview and apply", async () => {
      for (const meanwhile of [
        "DELETE FROM m_items WHERE id = 2300",
        "UPDATE m_items SET id = 99999 WHERE id = 2300",
      ]) {
        await seedItems(2400);
        const plan = await adapter.previewChange(
          update("m_items", [eq("note", "even")], "name", "changed"),
        );
        expect(plan.statements).toHaveLength(3);
        await sql.query(meanwhile);
        // The first two batches ran; the third is one row short: nothing is kept.
        const error = await failure(adapter.applyChange(plan));
        expect(error).toMatchObject({ code: "row_changed", message: MATCHING_ROW_GONE });
        expect(await count("m_items", "name = 'changed'")).toBe(0);
      }
    });

    it("writes the keys the preview counted: a row that stopped matching is still changed, a new match is not", async () => {
      await seedItems(10);
      const plan = await adapter.previewChange(
        update("m_items", [eq("note", "even")], "name", "picked"),
      );
      expect(plan.confirmRows).toBe(5);
      await sql.query("UPDATE m_items SET note = 'other' WHERE id = 2");
      await sql.query("UPDATE m_items SET note = 'even' WHERE id = 3");
      await sql.query("INSERT INTO m_items (id, name, qty, note) VALUES (11, 'old', 1, 'even')");
      expect(await adapter.applyChange(plan)).toEqual({ rowCount: 5 });
      expect(
        (await q<{ id: number }>("SELECT id FROM m_items WHERE name = 'picked' ORDER BY id")).map(
          (r) => r.id,
        ),
      ).toEqual([2, 4, 6, 8, 10]);
    });

    it("names the triggers that run and how often", async () => {
      await sql.query("TRUNCATE m_trig");
      await sql.query("INSERT INTO m_trig SELECT g, 'a' FROM generate_series(1, 3) AS g");
      const plan = await adapter.previewChange(update("m_trig", [eq("v", "a")], "v", "b"));
      const triggers = plan.warnings.find((w) => w.code === "triggers")!.message;
      expect(triggers).toContain("m_bu");
      expect(triggers).toContain("each of the 3 rows");
    });

    it("puts no value and no key in the preview, the history, an error or the log; a write is never built from the filter", async () => {
      await sql.query(`TRUNCATE ${quoteIdent(ODD_TABLE)}`);
      await sql.query(
        `INSERT INTO ${quoteIdent(ODD_TABLE)} VALUES (1, '${SECRET}-key', '${SECRET}-c0', 'old'), (2, '${SECRET}-key', 'other', 'old')`,
      );
      const filters: RowFilter[] = [
        { column: "c0", op: "contains", value: `${SECRET}-c0` },
        { column: "select", op: "between", values: ["0", "5"] },
      ];
      const plan = await adapter.previewChange(update(ODD_TABLE, filters, "ключ 🙂", SECRET));
      expect(plan.confirmRows).toBe(1);
      expect(shown(plan)).not.toContain(SECRET);
      // Every statement is the keyed batch: no condition of the filter, no value of it, in the text or the values.
      for (const statement of plan.statements) {
        expect(statement.text).toMatch(
          /^UPDATE .* FROM unnest\(\$1::text\[\], \$2::text\[\]\) AS x\(c0, c1\) WHERE dc_t\./,
        );
        expect(statement.text).not.toMatch(/strpos|BETWEEN|lower\(/);
        expect(JSON.stringify(statement.values)).not.toContain(`${SECRET}-c0`);
      }
      // The same for a delete.
      const deletion = await adapter.previewChange(remove(ODD_TABLE, filters));
      expect(shown(deletion)).not.toContain(SECRET);
      for (const statement of deletion.statements) {
        expect(statement.text).toMatch(/^DELETE FROM .* USING unnest\(/);
        expect(statement.text).not.toMatch(/strpos|BETWEEN|lower\(/);
        expect(JSON.stringify(statement.values)).not.toContain(`${SECRET}-c0`);
      }
    });
  });

  describe("delete_matching", () => {
    it("finds the keys at preview, needs the tick, and deletes exactly those rows in keyed batches", async () => {
      await seedItems(1200);
      const plan = await adapter.previewChange(
        remove("m_items", [eq("note", "odd", 1), eq("id", "2", 1)]),
      );
      expect(plan.destructive).toBe(true);
      expect(plan.confirmRows).toBe(601);
      expect(plan.statements.map((s) => s.expectRows)).toEqual([500, 101]);
      expect(statementText(plan)).toBe(
        'DELETE FROM "public"."m_items" AS dc_t USING unnest($1::text[]) AS x(c0) WHERE dc_t."id" = CAST(x.c0 AS integer);\n' +
          "-- the same statement runs for each of 2 batches of up to 500 rows (the values differ)",
      );
      expect(plan.effect).toBe(
        "Deletes the 601 rows of public.m_items that match the filter now. Rows are found by their key (id) when you apply: a row that matches the filter only after this preview is not deleted. 2 batches, all in one transaction: every row is deleted or none is.",
      );
      expect(plan.warnings.find((w) => w.code === "destructive")!.message).toContain(
        "The rows were chosen by the filter, and are deleted even if they changed since",
      );
      expect(changeColumns(plan.change)).toEqual(["note", "id"]);
      expect(await adapter.applyChange(plan)).toEqual({ rowCount: 601 });
      expect(await count("m_items")).toBe(599);
      expect(await count("m_items", "id % 2 = 1 OR id = 2")).toBe(0);
    });

    it("refuses an empty filter, and rolls everything back when a row is gone since the preview", async () => {
      await seedItems(1200);
      expect(await failure(adapter.previewChange(remove("m_items", [])))).toMatchObject({
        code: "invalid_change",
        message: EMPTY_FILTER,
      });
      const plan = await adapter.previewChange(remove("m_items", [eq("qty", "1")]));
      expect(plan.confirmRows).toBe(1200);
      await sql.query("DELETE FROM m_items WHERE id = 1199");
      expect(await failure(adapter.applyChange(plan))).toMatchObject({
        code: "row_changed",
        message: MATCHING_ROW_GONE,
      });
      expect(await count("m_items")).toBe(1199);
    });

    it("deletes the keys the preview counted: a row that stopped matching goes, a new match stays", async () => {
      await seedItems(10);
      const plan = await adapter.previewChange(remove("m_items", [eq("note", "odd")]));
      expect(plan.confirmRows).toBe(5);
      await sql.query("UPDATE m_items SET note = 'other' WHERE id = 1");
      await sql.query("INSERT INTO m_items (id, name, qty, note) VALUES (11, 'old', 1, 'odd')");
      expect(await adapter.applyChange(plan)).toEqual({ rowCount: 5 });
      expect(
        (await q<{ id: number }>("SELECT id FROM m_items ORDER BY id")).map((r) => r.id),
      ).toEqual([2, 4, 6, 8, 10, 11]);
    });

    it("works by a composite key with hostile names", async () => {
      const odd = quoteIdent(ODD_TABLE);
      await sql.query(`TRUNCATE ${odd}`);
      await sql.query(
        `INSERT INTO ${odd} VALUES (1, 'k', 'x', 'a'), (2, 'k', 'y', 'a'), (1, 'k''"', 'x', 'a')`,
      );
      const plan = await adapter.previewChange(remove(ODD_TABLE, [eq("c0", "x")]));
      expect(statementText(plan)).toBe(
        `DELETE FROM "public"."m ""odd"" ; table" AS dc_t USING unnest($1::text[], $2::text[]) AS x(c0, c1) WHERE dc_t."a""b c" = CAST(x.c0 AS text) AND dc_t."select" = CAST(x.c1 AS integer);`,
      );
      expect(await adapter.applyChange(plan)).toEqual({ rowCount: 2 });
      expect(await q(`SELECT "select" AS s, c0 FROM ${odd}`)).toEqual([{ s: 2, c0: "y" }]);
    });

    it("is refused by a foreign key that still points at a row (23503): a fixed sentence, nothing deleted", async () => {
      await sql.query("TRUNCATE m_child, m_parent");
      await sql.query(
        `INSERT INTO m_parent SELECT g, '${SECRET}' FROM generate_series(1, 600) AS g;
         INSERT INTO m_child VALUES (1, 550)`,
      );
      const plan = await adapter.previewChange(remove("m_parent", [eq("tag", SECRET)]));
      expect(shown(plan)).not.toContain(SECRET);
      expect(plan.warnings.find((w) => w.code === "referenced")?.message).toContain(
        "public.m_child.parent",
      );
      const error = await failure(adapter.applyChange(plan));
      expect(error.code).toBe("foreign_key_violation");
      expect(error.message).toBe(
        "This breaks a foreign key (m_child_parent_fkey): a referenced row is missing, or other rows still point at this one. Nothing was changed.",
      );
      expect(await count("m_parent")).toBe(600);
    });
  });

  describe("the limits", () => {
    it(`refuses more than ${MATCHING_MAX_ROWS.toLocaleString("en-US")} matching rows, and changes exactly that many`, async () => {
      let started = Date.now();
      const error = await failure(
        adapter.previewChange(
          update("m_big", [{ column: "grp", op: "gte", value: "0" }], "grp", "7"),
        ),
      );
      const refusedMs = Date.now() - started;
      expect(error.code).toBe("invalid_change");
      expect(error.message).toContain(
        "More than 100,000 rows match this filter: narrow the filter.",
      );

      started = Date.now();
      const plan = await adapter.previewChange(update("m_big", [eq("grp", "1")], "grp", "7"));
      const previewMs = Date.now() - started;
      expect(plan.confirmRows).toBe(MATCHING_MAX_ROWS);
      expect(plan.statements).toHaveLength(MATCHING_MAX_ROWS / IMPORT_BATCH_ROWS);
      started = Date.now();
      expect(await adapter.applyChange(plan)).toEqual({ rowCount: MATCHING_MAX_ROWS });
      const applyMs = Date.now() - started;
      expect(await count("m_big", "grp = 7")).toBe(MATCHING_MAX_ROWS);

      started = Date.now();
      const deletion = await adapter.previewChange(remove("m_big", [eq("grp", "7")]));
      const deletePreviewMs = Date.now() - started;
      started = Date.now();
      expect(await adapter.applyChange(deletion)).toEqual({ rowCount: MATCHING_MAX_ROWS });
      const deleteMs = Date.now() - started;
      expect(await count("m_big")).toBe(1);
      print(
        `matching rows, 100,000 integer keys: refusal of 100,001 ${refusedMs} ms; update preview ${previewMs} ms, apply ${applyMs} ms; delete preview ${deletePreviewMs} ms, apply ${deleteMs} ms`,
      );
    }, 120_000);

    it(`refuses keys of more than ${MATCHING_MAX_KEY_CHARS.toLocaleString("en-US")} characters in all, and one key value of more than ${LONG.toLocaleString("en-US")}`, async () => {
      let started = Date.now();
      const plan = await adapter.previewChange(remove("m_long", [eq("grp", "1")]));
      const fitsMs = Date.now() - started;
      expect(plan.confirmRows).toBe(FITS);
      expect(FITS * LONG).toBeLessThanOrEqual(MATCHING_MAX_KEY_CHARS);
      const heldChars = plan.statements
        .flatMap((s) => s.values[0] as string[])
        .reduce((sum, k) => sum + k.length, 0);
      expect(heldChars).toBe(FITS * LONG);

      started = Date.now();
      const tooMuch = await failure(
        adapter.previewChange(remove("m_long", [{ column: "grp", op: "in", values: ["1", "2"] }])),
      );
      const refusedMs = Date.now() - started;
      expect(tooMuch.code).toBe("invalid_change");
      expect(tooMuch.message).toContain("more than 8,000,000 characters in all");
      expect(tooMuch.message).toContain("narrow the filter");

      const tooLong = await failure(adapter.previewChange(remove("m_long", [eq("grp", "3")])));
      expect(tooLong.message).toContain("a key value longer than 4,096 characters");
      print(
        `matching rows, ${FITS} keys of ${LONG} characters: preview ${fitsMs} ms; refusal of one more ${refusedMs} ms`,
      );
    }, 60_000);

    it("stops at exactly the limits it is given (the planner, with low limits)", async () => {
      await seedItems(30);
      const plan = (
        change: Change,
        limits: { rows: number; keyChars: number; keyValueChars: number },
      ) =>
        withReadOnlyTransaction(pool, 10_000, (client) =>
          change.kind === "update_matching"
            ? planUpdateMatching(client, change, limits)
            : planDeleteMatching(
                client,
                change as Extract<Change, { kind: "delete_matching" }>,
                limits,
              ),
        );
      // ids 10 to 19: ten rows, twenty characters of key.
      const ten = [{ column: "id", op: "between", values: ["10", "19"] } as RowFilter];
      const wide = { rows: 1000, keyChars: 1000, keyValueChars: 100 };
      expect((await plan(remove("m_items", ten), { ...wide, rows: 10 })).confirmRows).toBe(10);
      expect((await failure(plan(remove("m_items", ten), { ...wide, rows: 9 }))).message).toContain(
        "More than 9 rows match this filter",
      );
      expect(
        (await plan(update("m_items", ten, "name", "x"), { ...wide, keyChars: 20 })).confirmRows,
      ).toBe(10);
      expect(
        (await failure(plan(update("m_items", ten, "name", "x"), { ...wide, keyChars: 19 })))
          .message,
      ).toContain("more than 19 characters in all");
      expect((await plan(remove("m_items", ten), { ...wide, keyValueChars: 2 })).confirmRows).toBe(
        10,
      );
      expect(
        (await failure(plan(remove("m_items", ten), { ...wide, keyValueChars: 1 }))).message,
      ).toContain("a key value longer than 1 character");
      // Batches of 500 whatever the limits: 30 rows are one batch.
      const all = await plan(remove("m_items", [eq("qty", "1")]), wide);
      expect(all.statements.map((s) => s.expectRows)).toEqual([30]);
    });
  });
});
