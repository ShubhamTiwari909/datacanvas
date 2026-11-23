/**
 * Bulk row changes against a real PostgreSQL (`docs/advanced-data-workspace-plan.md`, section 7; decision 159):
 * the same values set on several rows, several rows removed, each found by its key. Each row is one statement of
 * the existing builders, all in one transaction: every row is changed exactly once or nothing is. A row that
 * changed since it was loaded is left out and reported at PREVIEW, before anything is written; one that changes
 * between preview and apply rolls everything back.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import {
  DatabaseError,
  MAX_BULK_ROWS,
  statementText,
  type Change,
  type ColumnValue,
  type KeyValue,
  type TableRef,
} from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SECRET = "hunter2-SECRET-VALUE";

const SQL = `
  CREATE TABLE b_items (
    id int PRIMARY KEY, status text, qty int CHECK (qty >= 0), note text,
    total int GENERATED ALWAYS AS (qty * 2) STORED
  );
  CREATE TABLE b_audit (what text);
  CREATE FUNCTION b_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO b_audit VALUES (TG_OP); RETURN COALESCE(NEW, OLD); END $$;
  CREATE TABLE b_trig (id int PRIMARY KEY, v text);
  CREATE TRIGGER b_trig_any AFTER UPDATE OR DELETE ON b_trig FOR EACH ROW EXECUTE PROCEDURE b_audit_fn();
  CREATE TABLE b_composite (a int, b text, v text, PRIMARY KEY (a, b));
  CREATE TABLE b_parent (id int PRIMARY KEY);
  CREATE TABLE b_child (id int PRIMARY KEY, parent_id int REFERENCES b_parent (id));
  CREATE TABLE b_cascade_child (id int PRIMARY KEY, parent_id int REFERENCES b_parent (id) ON DELETE CASCADE);
  CREATE TABLE b_nokey (v text);
  CREATE VIEW b_view AS SELECT id FROM b_items;
`;

describe.skipIf(!testDatabaseUrl())("PostgresAdapter bulk row changes", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;
  let sql: pg.Client;
  const ref = (name: string): TableRef => ({ schema: "public", name });
  const key = (pairs: Record<string, string>): KeyValue[] =>
    Object.entries(pairs).map(([column, value]) => ({ column, value }));
  const cells = (pairs: Record<string, string | null>): ColumnValue[] =>
    Object.entries(pairs).map(([column, value]) => ({ column, value }));
  const setRows = (
    table: string,
    set: Record<string, string | null>,
    rows: Array<{ id: number; expected: Record<string, string | null> }>,
  ): Change => ({
    kind: "update_rows",
    table: ref(table),
    set: cells(set),
    rows: rows.map((r) => ({ key: key({ id: String(r.id) }), expected: cells(r.expected) })),
  });
  const removeRows = (table: string, ids: Array<number | string>): Change => ({
    kind: "delete_rows",
    table: ref(table),
    rows: ids.map((id) => ({ key: key({ id: String(id) }) })),
  });
  const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> =>
    (await sql.query(text)).rows as T[];
  const reset = async () => {
    await sql.query(
      "TRUNCATE b_items, b_audit, b_trig, b_composite, b_child, b_cascade_child, b_parent CASCADE",
    );
    await sql.query(
      "INSERT INTO b_items (id, status, qty, note) SELECT i, 'new', i, 'n' || i FROM generate_series(1, 10) i",
    );
  };

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

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    sql = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await sql.connect();
    await sql.query(SQL);
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
  }, 60_000);
  afterAll(async () => {
    await adapter?.disconnect();
    await sql?.end().catch(() => {});
    await db?.dispose().catch(() => {});
  });

  describe("update_rows", () => {
    it("sets the same values on the chosen rows and only those, in one transaction", async () => {
      await reset();
      const plan = await adapter.previewChange(
        setRows("b_items", { status: "done" }, [
          { id: 2, expected: { status: "new" } },
          { id: 5, expected: { status: "new" } },
          { id: 7, expected: { status: "new" } },
        ]),
      );
      expect(plan.skipped).toEqual([]);
      expect(plan.statements).toHaveLength(3);
      expect(plan.destructive).toBe(false);
      expect(plan.effect).toContain("3 rows");
      const applied = await adapter.applyChange(plan);
      expect(applied.rowCount).toBe(3);
      expect(await q("SELECT id FROM b_items WHERE status = 'done' ORDER BY id")).toEqual([
        { id: 2 },
        { id: 5 },
        { id: 7 },
      ]);
      expect((await q("SELECT count(*)::int AS n FROM b_items WHERE status = 'new'"))[0]).toEqual({
        n: 7,
      });
    });

    it("shows the statement once, with how many times it runs", async () => {
      await reset();
      const plan = await adapter.previewChange(
        setRows(
          "b_items",
          { status: "x" },
          [1, 2, 3, 4].map((id) => ({ id, expected: { status: "new" } })),
        ),
      );
      const text = statementText(plan);
      expect(text.match(/UPDATE/g)).toHaveLength(1);
      expect(text).toContain("the same statement runs for each of 4 rows");
      expect(text).not.toContain("done");
    });

    it("sets NULL, and keeps NULL apart from the empty string in the check of what was seen", async () => {
      await reset();
      await sql.query(
        "UPDATE b_items SET note = NULL WHERE id = 1; UPDATE b_items SET note = '' WHERE id = 2",
      );
      const plan = await adapter.previewChange(
        setRows("b_items", { note: "now" }, [
          { id: 1, expected: { note: null } },
          { id: 2, expected: { note: null } }, // saw NULL, but it holds the empty string now
        ]),
      );
      expect(plan.skipped).toEqual([1]);
      await adapter.applyChange(plan);
      expect(await q("SELECT id, note FROM b_items WHERE id IN (1, 2) ORDER BY id")).toEqual([
        { id: 1, note: "now" },
        { id: 2, note: "" },
      ]);
    });

    it("leaves out a row that changed since it was loaded, and says so BEFORE writing anything", async () => {
      await reset();
      await sql.query("UPDATE b_items SET status = 'someone-else' WHERE id = 3");
      const plan = await adapter.previewChange(
        setRows(
          "b_items",
          { status: "done" },
          [2, 3, 4].map((id) => ({ id, expected: { status: "new" } })),
        ),
      );
      // The preview wrote nothing.
      expect(await q("SELECT count(*)::int AS n FROM b_items WHERE status = 'done'")).toEqual([
        { n: 0 },
      ]);
      expect(plan.skipped).toEqual([1]);
      expect(plan.statements).toHaveLength(2);
      expect(plan.effect).toContain("1 of the 3 rows changed since you loaded them");
      await adapter.applyChange(plan);
      expect(await q("SELECT id, status FROM b_items WHERE id IN (2, 3, 4) ORDER BY id")).toEqual([
        { id: 2, status: "done" },
        { id: 3, status: "someone-else" },
        { id: 4, status: "done" },
      ]);
    });

    it("leaves out a row that is gone, and refuses when every row is out", async () => {
      await reset();
      await sql.query("DELETE FROM b_items WHERE id = 2");
      const plan = await adapter.previewChange(
        setRows("b_items", { status: "x" }, [
          { id: 2, expected: { status: "new" } },
          { id: 3, expected: { status: "new" } },
        ]),
      );
      expect(plan.skipped).toEqual([0]);
      await sql.query("UPDATE b_items SET status = 'changed'");
      const error = await failure(
        adapter.previewChange(
          setRows("b_items", { status: "x" }, [
            { id: 3, expected: { status: "new" } },
            { id: 4, expected: { status: "new" } },
          ]),
        ),
      );
      expect(error.code).toBe("row_changed");
    });

    it("rolls EVERYTHING back when a row changes between preview and apply", async () => {
      await reset();
      const plan = await adapter.previewChange(
        setRows(
          "b_items",
          { status: "done" },
          [1, 2, 3, 4, 5].map((id) => ({ id, expected: { status: "new" } })),
        ),
      );
      // Someone else changes the fourth row after the preview.
      await sql.query("UPDATE b_items SET status = 'sneaky' WHERE id = 4");
      const error = await failure(adapter.applyChange(plan));
      expect(error.code).toBe("row_changed");
      // Rows 1 to 3 were updated before the fourth statement failed: they are back as they were.
      expect(await q("SELECT id, status FROM b_items WHERE id <= 5 ORDER BY id")).toEqual([
        { id: 1, status: "new" },
        { id: 2, status: "new" },
        { id: 3, status: "new" },
        { id: 4, status: "sneaky" },
        { id: 5, status: "new" },
      ]);
    });

    it("rolls everything back when the database refuses one row, with a fixed message", async () => {
      await reset();
      await sql.query("ALTER TABLE b_items DROP CONSTRAINT b_items_qty_check");
      await sql.query("UPDATE b_items SET qty = 100 WHERE id = 4");
      await sql.query(
        "ALTER TABLE b_items ADD CONSTRAINT b_items_qty_check CHECK (qty >= 0) NOT VALID",
      );
      const plan = await adapter.previewChange(
        setRows(
          "b_items",
          { qty: "-1" },
          [1, 2, 3].map((id) => ({ id, expected: { qty: String(id) } })),
        ),
      );
      const error = await failure(adapter.applyChange(plan));
      expect(error.code).toBe("check_violation");
      expect(await q("SELECT id, qty FROM b_items WHERE id <= 3 ORDER BY id")).toEqual([
        { id: 1, qty: 1 },
        { id: 2, qty: 2 },
        { id: 3, qty: 3 },
      ]);
    });

    it("checks the value once, naming the column and never the value", async () => {
      await reset();
      const error = await failure(
        adapter.previewChange(
          setRows("b_items", { qty: `abc-${SECRET}` }, [{ id: 1, expected: { qty: "1" } }]),
        ),
      );
      expect(error.code).toBe("invalid_value");
      expect(error.message).toContain("qty");
    });

    it("refuses a key value that does not fit its type with a fixed message", async () => {
      await reset();
      const change: Change = {
        kind: "update_rows",
        table: ref("b_items"),
        set: cells({ status: "x" }),
        rows: [{ key: key({ id: `not-a-number-${SECRET}` }), expected: cells({ status: "new" }) }],
      };
      const error = await failure(adapter.previewChange(change));
      expect(error.code).toBe("invalid_value");
      // Nothing was left half-done in the preview's transaction: the next preview works.
      await adapter.previewChange(
        setRows("b_items", { status: "x" }, [{ id: 1, expected: { status: "new" } }]),
      );
    });

    it("refuses a generated column, a column that does not exist, an empty change, a row named twice and too many rows", async () => {
      await reset();
      const one = [{ id: 1, expected: {} as Record<string, string | null> }];
      expect(
        (
          await failure(
            adapter.previewChange(
              setRows("b_items", { total: "5" }, [{ id: 1, expected: { total: "2" } }]),
            ),
          )
        ).code,
      ).toBe("invalid_change");
      expect(
        (
          await failure(
            adapter.previewChange(
              setRows("b_items", { nope: "5" }, [{ id: 1, expected: { nope: null } }]),
            ),
          )
        ).code,
      ).toBe("invalid_change");
      expect((await failure(adapter.previewChange(setRows("b_items", {}, one)))).code).toBe(
        "invalid_change",
      );
      const twice = setRows("b_items", { status: "x" }, [
        { id: 1, expected: { status: "new" } },
        { id: 1, expected: { status: "new" } },
      ]);
      expect((await failure(adapter.previewChange(twice))).code).toBe("invalid_change");
      const many = setRows(
        "b_items",
        { status: "x" },
        Array.from({ length: MAX_BULK_ROWS + 1 }, (_, i) => ({
          id: i + 1,
          expected: { status: "new" },
        })),
      );
      expect((await failure(adapter.previewChange(many))).code).toBe("invalid_change");
    });

    it("finds rows by a composite key, in whatever order its columns are given, and refuses a part of the key", async () => {
      await sql.query("INSERT INTO b_composite VALUES (1,'a','x'),(1,'b','y'),(2,'a','z')");
      const change: Change = {
        kind: "update_rows",
        table: ref("b_composite"),
        set: cells({ v: "changed" }),
        rows: [
          { key: key({ b: "a", a: "1" }), expected: cells({ v: "x" }) },
          { key: key({ a: "2", b: "a" }), expected: cells({ v: "z" }) },
        ],
      };
      await adapter.applyChange(await adapter.previewChange(change));
      expect(await q("SELECT a, b, v FROM b_composite ORDER BY a, b")).toEqual([
        { a: 1, b: "a", v: "changed" },
        { a: 1, b: "b", v: "y" },
        { a: 2, b: "a", v: "changed" },
      ]);
      const same: Change = {
        ...change,
        rows: [
          { key: key({ a: "1", b: "b" }), expected: cells({ v: "y" }) },
          { key: key({ b: "b", a: "1" }), expected: cells({ v: "y" }) },
        ],
      };
      expect((await failure(adapter.previewChange(same))).code).toBe("invalid_change");
      const part: Change = {
        ...change,
        rows: [{ key: key({ a: "1" }), expected: cells({ v: "x" }) }],
      };
      expect((await failure(adapter.previewChange(part))).code).toBe("invalid_change");
    });

    it("says a trigger runs for each row, and it does", async () => {
      await sql.query("TRUNCATE b_trig, b_audit");
      await sql.query("INSERT INTO b_trig VALUES (1,'a'),(2,'a'),(3,'a')");
      const plan = await adapter.previewChange(
        setRows(
          "b_trig",
          { v: "b" },
          [1, 2, 3].map((id) => ({ id, expected: { v: "a" } })),
        ),
      );
      expect(plan.warnings.find((w) => w.code === "triggers")?.message).toContain(
        "for each of the 3 rows",
      );
      await adapter.applyChange(plan);
      expect(await q("SELECT count(*)::int AS n FROM b_audit")).toEqual([{ n: 3 }]);
    });

    it("refuses a view and a table without a key", async () => {
      expect(
        (
          await failure(
            adapter.previewChange(
              setRows("b_view", { id: "1" }, [{ id: 1, expected: { id: "1" } }]),
            ),
          )
        ).code,
      ).toBe("not_editable");
      expect(
        (
          await failure(
            adapter.previewChange(
              setRows("b_nokey", { v: "1" }, [{ id: 1, expected: { v: "1" } }]),
            ),
          )
        ).code,
      ).toBe("not_editable");
    });
  });

  describe("delete_rows", () => {
    it("deletes the chosen rows and only those, says it cannot be undone, and counts them", async () => {
      await reset();
      const plan = await adapter.previewChange(removeRows("b_items", [2, 4, 6]));
      expect(plan.destructive).toBe(true);
      expect(plan.warnings.some((w) => w.code === "destructive")).toBe(true);
      expect(plan.effect).toContain("3 rows");
      expect((await adapter.applyChange(plan)).rowCount).toBe(3);
      expect((await q("SELECT id FROM b_items ORDER BY id")).map((r) => r.id)).toEqual([
        1, 3, 5, 7, 8, 9, 10,
      ]);
    });

    it("leaves out a row that is already gone, at preview", async () => {
      await reset();
      await sql.query("DELETE FROM b_items WHERE id = 3");
      const plan = await adapter.previewChange(removeRows("b_items", [2, 3, 4]));
      expect(plan.skipped).toEqual([1]);
      await adapter.applyChange(plan);
      expect((await q("SELECT count(*)::int AS n FROM b_items"))[0]).toEqual({ n: 7 });
    });

    it("deletes none of the rows when the database refuses one (a foreign key), with a fixed message", async () => {
      await sql.query("TRUNCATE b_child, b_cascade_child, b_parent CASCADE");
      await sql.query("INSERT INTO b_parent VALUES (1),(2),(3)");
      await sql.query("INSERT INTO b_child VALUES (1, 3)");
      const plan = await adapter.previewChange(removeRows("b_parent", [1, 2, 3]));
      expect(plan.warnings.some((w) => w.code === "referenced")).toBe(true);
      const error = await failure(adapter.applyChange(plan));
      expect(error.code).toBe("foreign_key_violation");
      expect((await q("SELECT count(*)::int AS n FROM b_parent"))[0]).toEqual({ n: 3 });
    });

    it("rolls everything back when a row is deleted by someone else between preview and apply", async () => {
      await reset();
      const plan = await adapter.previewChange(removeRows("b_items", [1, 2, 3, 4]));
      await sql.query("DELETE FROM b_items WHERE id = 3");
      expect((await failure(adapter.applyChange(plan))).code).toBe("row_changed");
      expect((await q("SELECT count(*)::int AS n FROM b_items"))[0]).toEqual({ n: 9 });
    });

    it("names what a cascade reaches, and a trigger that runs for each row", async () => {
      await sql.query("TRUNCATE b_child, b_cascade_child, b_parent CASCADE");
      await sql.query("INSERT INTO b_parent VALUES (1),(2)");
      await sql.query("INSERT INTO b_cascade_child VALUES (1, 1)");
      const plan = await adapter.previewChange(removeRows("b_parent", [1, 2]));
      const referenced = plan.warnings.find((w) => w.code === "referenced")?.message ?? "";
      expect(referenced).toContain("b_cascade_child");
      await adapter.applyChange(plan);
      expect(await q("SELECT count(*)::int AS n FROM b_cascade_child")).toEqual([{ n: 0 }]);
      await sql.query("TRUNCATE b_trig, b_audit");
      await sql.query("INSERT INTO b_trig VALUES (1,'a'),(2,'a')");
      const withTrigger = await adapter.previewChange(removeRows("b_trig", [1, 2]));
      expect(withTrigger.warnings.find((w) => w.code === "triggers")?.message).toContain(
        "for each of the 2 rows",
      );
    });

    it("refuses an empty list, too many rows, a row named twice and a key of the wrong shape", async () => {
      await reset();
      expect((await failure(adapter.previewChange(removeRows("b_items", [])))).code).toBe(
        "invalid_change",
      );
      const many = removeRows(
        "b_items",
        Array.from({ length: MAX_BULK_ROWS + 1 }, (_, i) => i + 1),
      );
      expect((await failure(adapter.previewChange(many))).code).toBe("invalid_change");
      expect((await failure(adapter.previewChange(removeRows("b_items", [1, 1])))).code).toBe(
        "invalid_change",
      );
      const wrong: Change = {
        kind: "delete_rows",
        table: ref("b_items"),
        rows: [{ key: key({ status: "new" }) }],
      };
      expect((await failure(adapter.previewChange(wrong))).code).toBe("invalid_change");
    });

    it("refuses a hostile key value as a value, not as SQL", async () => {
      await reset();
      const hostile = "1; DELETE FROM b_items; --";
      expect((await failure(adapter.previewChange(removeRows("b_items", [hostile])))).code).toBe(
        "invalid_value",
      );
      expect((await q("SELECT count(*)::int AS n FROM b_items"))[0]).toEqual({ n: 10 });
    });
  });

  describe("review findings (1.9.0)", () => {
    it("refuses a row named twice in different spellings of its key ('1' and '01'), for an update and a delete", async () => {
      await reset();
      for (const change of [
        setRows("b_items", { status: "done" }, [
          { id: 1, expected: { status: "new" } },
          { id: "01" as unknown as number, expected: { status: "new" } },
        ]),
        removeRows("b_items", [1, "01"]),
      ]) {
        const failed = await failure(adapter.previewChange(change));
        expect(failed.message).toMatch(/listed twice/i);
      }
      // Nothing was written, and no trigger ran twice.
      expect((await q("SELECT count(*)::int AS n FROM b_items"))[0]).toEqual({ n: 10 });
    });

    it("says a delete is found by its key: a row that changed since it was seen is still deleted, and a missing one is left out in words that do not claim a comparison", async () => {
      await reset();
      await sql.query("UPDATE b_items SET status = 'changed' WHERE id = 1");
      await sql.query("DELETE FROM b_items WHERE id = 2");
      const plan = await adapter.previewChange(removeRows("b_items", [1, 2, 3]));
      expect(plan.skipped).toEqual([1]);
      expect(plan.effect).toContain("is gone");
      expect(plan.effect).toContain("does not compare values");
      expect(plan.effect).not.toContain("changed since you loaded");
      expect((await adapter.applyChange(plan)).rowCount).toBe(2);
    });
  });

  it("refuses a plan whose table was replaced between preview and apply, and writes nothing", async () => {
    await sql.query("CREATE TABLE b_swap (id int PRIMARY KEY, v text)");
    await sql.query("INSERT INTO b_swap VALUES (1,'a'),(2,'a')");
    const plan = await adapter.previewChange(
      setRows(
        "b_swap",
        { v: "b" },
        [1, 2].map((id) => ({ id, expected: { v: "a" } })),
      ),
    );
    await sql.query("DROP TABLE b_swap");
    await sql.query("CREATE TABLE b_swap (id int PRIMARY KEY, v text)");
    await sql.query("INSERT INTO b_swap VALUES (1,'a'),(2,'a')");
    await failure(adapter.applyChange(plan));
    expect(await q("SELECT v FROM b_swap ORDER BY id")).toEqual([{ v: "a" }, { v: "a" }]);
  });
});
