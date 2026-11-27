/**
 * Findings of the independent review of the 1.12.0 write side (`docs/write-side-v2-plan.md`, section 13), each with
 * a test that failed before its fix:
 *
 *   1. an import by key must not be a way to test whether a value of a hidden (sensitive-named) key exists;
 *   3. a repeated key is found under the key column's OWN collation (a nondeterministic one treats 'k0' and 'K0' as
 *      one key), not under the default collation;
 *   4. a filtered delete on a table that cascades onto itself says so at preview, instead of failing at apply with
 *      "a row is gone";
 *   5. a table that has child tables (inheritance) is refused for the keyed changes.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import {
  DatabaseError,
  type Change,
  type RowFilter,
  type TableRef,
} from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SQL = `
  CREATE TABLE r_secret (id int PRIMARY KEY, api_key text NOT NULL UNIQUE, v text);
  INSERT INTO r_secret VALUES (1, 'sk-live-abc', 'old');
  CREATE TABLE r_tree (id int PRIMARY KEY, parent int REFERENCES r_tree (id) ON DELETE CASCADE);
  CREATE TABLE r_parent (id int PRIMARY KEY, v text);
  CREATE TABLE r_child () INHERITS (r_parent);
  INSERT INTO r_parent VALUES (1, 'a'), (2, 'b');
  INSERT INTO r_child VALUES (3, 'c'), (4, 'd');
  CREATE TABLE r_plist (id int NOT NULL, region text NOT NULL, v text, PRIMARY KEY (id, region))
    PARTITION BY LIST (region);
  CREATE TABLE r_plist_eu PARTITION OF r_plist FOR VALUES IN ('eu');
  INSERT INTO r_plist VALUES (1, 'eu', 'x');
`;

type Rows = Array<Array<string | null>>;

describe.skipIf(!testDatabaseUrl())("PostgresAdapter write-side review findings", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;
  let sql: pg.Client;
  let icu = false;
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
  const all = (column: string): RowFilter => ({ column, op: "is_not_null" }) as RowFilter;
  const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> =>
    (await sql.query(text)).rows as T[];

  async function failure(work: Promise<unknown>): Promise<DatabaseError> {
    const error = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DatabaseError);
    return error as DatabaseError;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    sql = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await sql.connect();
    await sql.query(SQL);
    try {
      await sql.query(
        `CREATE COLLATION ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
      );
      await sql.query(`CREATE TABLE r_ci (k text COLLATE ci PRIMARY KEY, v text)`);
      icu = true;
    } catch {
      icu = false;
    }
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
  }, 60_000);

  afterAll(async () => {
    await adapter?.disconnect();
    await sql?.end().catch(() => {});
    await db?.dispose().catch(() => {});
  });

  describe("1. no existence oracle on a hidden key", () => {
    it("refuses an import by a key whose name looks sensitive, whatever the values", async () => {
      for (const value of ["sk-live-abc", "sk-live-WRONG"]) {
        const rows: Rows = [[value, "new"]];
        const a = await failure(
          adapter.previewChange(byKey("r_secret", ["api_key"], ["api_key", "v"], rows)),
        );
        const b = await failure(
          adapter.previewChange(upsert("r_secret", ["api_key"], ["api_key", "v"], rows, ["v"])),
        );
        for (const failed of [a, b]) {
          expect(failed.code).toBe("invalid_change");
          expect(failed.message).toContain("api_key");
          expect(failed.message).toContain("cannot be used to import by key");
          expect(failed.message).not.toContain(value);
        }
        // The same sentence for a value that exists and for one that does not: nothing tells them apart.
        expect(a.message).toBe(
          (
            await failure(
              adapter.previewChange(
                byKey("r_secret", ["api_key"], ["api_key", "v"], [["other", "x"]]),
              ),
            )
          ).message,
        );
      }
    });

    it("still imports by an ordinary key, and may update a sensitive column's value", async () => {
      const plan = await adapter.previewChange(
        byKey("r_secret", ["id"], ["id", "api_key"], [["1", "sk-live-new"]]),
      );
      expect(plan.counts).toEqual({ insert: 0, update: 1, unchanged: 0 });
    });
  });

  describe("3. a repeated key under the column's own collation", () => {
    const keys = (n: number): Rows => Array.from({ length: n }, (_, i) => [`k${i}`, "v"]);
    it.skipIf(false)(
      "refuses 'K0' after 'k0' in another batch, for upsert_rows and update_by_key",
      async (ctx) => {
        if (!icu) return ctx.skip();
        await sql.query("TRUNCATE r_ci");
        await sql.query("INSERT INTO r_ci SELECT 'k' || g, 'old' FROM generate_series(0, 499) g");
        const rows: Rows = [...keys(500), ["K0", "v"]];
        for (const change of [
          upsert("r_ci", ["k"], ["k", "v"], rows, ["v"]),
          byKey("r_ci", ["k"], ["k", "v"], rows),
        ]) {
          const failed = await failure(adapter.previewChange(change));
          expect(failed.code).toBe("invalid_change");
          expect(failed.message).toContain("have the same key");
          expect(failed.message).toContain("rows 1 and 501");
        }
        expect((await q("SELECT count(*)::int AS n FROM r_ci"))[0]).toEqual({ n: 500 });
      },
    );
  });

  describe("4. a filtered delete on a table that cascades onto itself", () => {
    const seed = async (n: number) => {
      await sql.query("TRUNCATE r_tree");
      await sql.query(
        `INSERT INTO r_tree SELECT g, CASE WHEN g = 1 THEN NULL ELSE 1 END FROM generate_series(1, ${n}) g`,
      );
    };
    const remove = (): Change => ({
      kind: "delete_matching",
      table: ref("r_tree"),
      filters: [all("id")],
      revealColumns: [],
    });

    it("refuses at preview when more than one batch is needed, with a fixed sentence", async () => {
      await seed(1000);
      const failed = await failure(adapter.previewChange(remove()));
      expect(failed.code).toBe("invalid_change");
      expect(failed.message).toBe(
        "This table's rows cascade onto other rows of the same table, so more than 500 of them cannot be deleted by filter in one change. Narrow the filter or delete them in smaller groups.",
      );
      expect((await q("SELECT count(*)::int AS n FROM r_tree"))[0]).toEqual({ n: 1000 });
    });

    it("runs a single batch, with a warning that the cascade can delete more rows of the table", async () => {
      await seed(400);
      const plan = await adapter.previewChange(remove());
      expect(plan.confirmRows).toBe(400);
      expect(plan.warnings.map((w) => w.message).join(" ")).toContain(
        "cascade onto other rows of this same table",
      );
      expect(await adapter.applyChange(plan)).toEqual({ rowCount: 400 });
      expect((await q("SELECT count(*)::int AS n FROM r_tree"))[0]).toEqual({ n: 0 });
    });
  });

  describe("5. a table with child tables (inheritance)", () => {
    const FIXED =
      "This table has child tables that inherit from it (table inheritance), so a change by key would also reach their rows, which have no key of their own. Use the SQL tab for this change.";
    it("refuses the keyed changes on a parent that has children", async () => {
      const changes: Change[] = [
        upsert("r_parent", ["id"], ["id", "v"], [["1", "z"]], ["v"]),
        byKey("r_parent", ["id"], ["id", "v"], [["1", "z"]]),
        {
          kind: "update_matching",
          table: ref("r_parent"),
          filters: [all("id")],
          revealColumns: [],
          set: { column: "v", value: "z" },
        },
        {
          kind: "delete_matching",
          table: ref("r_parent"),
          filters: [all("id")],
          revealColumns: [],
        },
        {
          kind: "edit_cells",
          table: ref("r_parent"),
          revealColumns: [],
          rows: [
            {
              key: [{ column: "id", value: "1" }],
              changes: [{ column: "v", value: "z", expected: "a" }],
            },
          ],
        } as unknown as Change,
      ];
      for (const change of changes) {
        const failed = await failure(adapter.previewChange(change));
        expect(failed.code, change.kind).toBe("not_editable");
        expect(failed.message, change.kind).toBe(FIXED);
      }
    });

    it("still allows a partitioned table", async () => {
      const plan = await adapter.previewChange(
        byKey("r_plist", ["id", "region"], ["id", "region", "v"], [["1", "eu", "y"]]),
      );
      expect(plan.counts?.update).toBe(1);
    });
  });
});
