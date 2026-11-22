/**
 * `exportRows()` against a real PostgreSQL (`docs/advanced-data-workspace-plan.md`, section 8): the rows
 * as filtered and sorted on screen, read through a cursor in batches; a hidden column left out and named;
 * values whole beyond a page's cell limit; the row limit; the consumer's stop and abort; and that no error
 * repeats a value.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import {
  EXPORT_BATCH_ROWS,
  EXPORT_MAX_ROWS,
  ROWS_CELL_CHARS,
  type ExportEvent,
  type ExportRowsOptions,
} from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SECRET = "hunter2-SECRET-VALUE";

const SQL = `
  CREATE TABLE people (id int PRIMARY KEY, name text, score int, doc jsonb, password_hash text);
  INSERT INTO people VALUES
    (1, 'ann', 10, '{"a": 1}', '${SECRET}'),
    (2, 'bob', 20, NULL, 'x'),
    (3, 'cy', 30, '{"b": [1, 2]}', NULL),
    (4, '=SUM(1)', 5, '{}', 'y');
  CREATE TABLE long_values (id int PRIMARY KEY, t text);
  INSERT INTO long_values VALUES (1, repeat('x', 5000)), (2, repeat('y', 1000001));
  CREATE TABLE nokey (v text);
  INSERT INTO nokey SELECT 'row' || i FROM generate_series(1, 5) i;
  CREATE TABLE big (id int PRIMARY KEY, n int);
  INSERT INTO big SELECT i, i FROM generate_series(1, ${EXPORT_MAX_ROWS + 10}) i;
  CREATE TABLE just_secrets (password text);
  INSERT INTO just_secrets VALUES ('${SECRET}');
  CREATE TABLE wide_empty (id int PRIMARY KEY);
  CREATE VIEW people_view AS SELECT id, name FROM people;
  CREATE TABLE two_rows (id int PRIMARY KEY);
  INSERT INTO two_rows VALUES (1), (2);
  CREATE TABLE aliases (a text, c0 int PRIMARY KEY, k0 int, r int, s0 int);
  INSERT INTO aliases VALUES ('z', 1, 3, 3, 3), ('a', 2, 2, 2, 2), ('m', 3, 1, 1, 1);
  CREATE TABLE heavy (id int PRIMARY KEY, a text, b text);
  INSERT INTO heavy SELECT i, repeat('a', 1000000), repeat('b', 1000000) FROM generate_series(1, 150) i;
`;

describe.skipIf(!testDatabaseUrl())("PostgreSQL exportRows", () => {
  let db: TestDatabase;
  let client: pg.Client;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    client = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await client.connect();
    await client.query(SQL);
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
  }, 180_000);
  afterAll(async () => {
    await adapter?.disconnect();
    await client?.end().catch(() => {});
    await db?.dispose().catch(() => {});
  });

  interface Got {
    columns: string[];
    leftOut: string[];
    rows: Array<Array<string | null>>;
    batches: number;
    biggestBatch: number;
    end: Extract<ExportEvent, { kind: "end" }> | null;
    order: string[];
  }
  const read = async (
    table: string,
    options: Partial<ExportRowsOptions> = {},
    stopAfter?: number,
    signal?: { aborted: boolean },
  ): Promise<Got> => {
    const got: Got = {
      columns: [],
      leftOut: [],
      rows: [],
      batches: 0,
      biggestBatch: 0,
      end: null,
      order: [],
    };
    await adapter.exportRows(
      { schema: "public", name: table },
      { revealColumns: [], ...options },
      (event) => {
        got.order.push(event.kind);
        if (event.kind === "start") {
          got.columns = event.columns.map((c) => c.name);
          got.leftOut = event.leftOut;
        } else if (event.kind === "rows") {
          got.batches += 1;
          got.biggestBatch = Math.max(got.biggestBatch, event.rows.length);
          got.rows.push(...event.rows);
          if (stopAfter !== undefined && got.rows.length >= stopAfter) return false;
        } else {
          got.end = event;
        }
        return undefined;
      },
      signal,
    );
    return got;
  };
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return "(no error)";
  };

  it("reads every row in key order, as text, NULL kept as null, and says how it ended", async () => {
    const got = await read("people");
    expect(got.order).toEqual(["start", "rows", "end"]);
    expect(got.columns).toEqual(["id", "name", "score", "doc"]);
    expect(got.leftOut).toEqual(["password_hash"]);
    expect(got.rows.map((r) => r[0])).toEqual(["1", "2", "3", "4"]);
    expect(got.rows[1]).toEqual(["2", "bob", "20", null]);
    expect(got.rows[0]![3]).toBe('{"a": 1}');
    expect(got.end).toEqual({ kind: "end", rows: 4, cut: null, cellsCut: 0 });
  });

  it("leaves a hidden column out unless it was revealed, and never reads it otherwise", async () => {
    const hidden = await read("people");
    expect(JSON.stringify(hidden.rows)).not.toContain(SECRET);
    const revealed = await read("people", { revealColumns: ["password_hash"] });
    expect(revealed.columns).toContain("password_hash");
    expect(revealed.leftOut).toEqual([]);
    expect(JSON.stringify(revealed.rows)).toContain(SECRET);
    // A table of nothing but hidden columns: no columns, rows of nothing.
    const none = await read("just_secrets");
    expect(none.columns).toEqual([]);
    expect(none.leftOut).toEqual(["password"]);
    expect(JSON.stringify(none.rows)).not.toContain(SECRET);
  });

  it("applies the sort and the conditions of the screen, and refuses to sort or filter a hidden column", async () => {
    const sorted = await read("people", { sort: { column: "score", direction: "desc" } });
    expect(sorted.rows.map((r) => r[0])).toEqual(["3", "2", "1", "4"]);
    const filtered = await read("people", {
      filters: [{ column: "score", op: "gte", value: "10" }],
    });
    expect(filtered.rows.map((r) => r[0])).toEqual(["1", "2", "3"]);
    const grouped = await read("people", {
      filters: [
        { column: "name", op: "eq", value: "ann", group: 1 },
        { column: "name", op: "eq", value: "cy", group: 1 },
      ],
    });
    expect(grouped.rows.map((r) => r[0])).toEqual(["1", "3"]);
    expect(
      await code(read("people", { sort: { column: "password_hash", direction: "asc" } })),
    ).toBe("invalid_request");
    expect(
      await code(
        read("people", { filters: [{ column: "password_hash", op: "contains", value: "h" }] }),
      ),
    ).toBe("invalid_request");
  });

  it("treats a hostile condition value as a value, and a value of the wrong type as a fixed code", async () => {
    const hostile = await read("people", {
      filters: [{ column: "name", op: "eq", value: "x'; DROP TABLE people; --" }],
    });
    expect(hostile.rows).toEqual([]);
    expect((await client.query("SELECT count(*)::int AS n FROM people")).rows[0].n).toBe(4);
    let message = "";
    try {
      await read("people", { filters: [{ column: "score", op: "eq", value: `abc-${SECRET}` }] });
    } catch (error) {
      message = String((error as Error).message);
      expect((error as { code?: string }).code).toBe("invalid_request");
    }
    expect(message).not.toContain(SECRET);
  });

  it("reads a value whole beyond a page's cell limit, and counts the ones it had to cut", async () => {
    const got = await read("long_values");
    expect(got.rows[0]![1]).toHaveLength(5000);
    expect(5000).toBeGreaterThan(ROWS_CELL_CHARS);
    expect(got.rows[1]![1]).toHaveLength(1_000_000);
    expect(got.end).toMatchObject({ rows: 2, cellsCut: 1 });
  });

  it("reads a table without a key and refuses a view's missing key nowhere: a view is read too", async () => {
    expect((await read("nokey")).rows).toHaveLength(5);
    expect((await read("people_view")).columns).toEqual(["id", "name"]);
  });

  it("stops at the row limit and says it was cut, in batches that never exceed the batch size", async () => {
    const got = await read("big");
    expect(got.rows).toHaveLength(EXPORT_MAX_ROWS);
    expect(got.end).toMatchObject({ rows: EXPORT_MAX_ROWS, cut: "rows" });
    // Batches are sized by what they hold (the first is small), and never exceed the most rows of a fetch.
    expect(got.batches).toBeGreaterThanOrEqual(Math.ceil(EXPORT_MAX_ROWS / EXPORT_BATCH_ROWS));
    expect(got.biggestBatch).toBeLessThanOrEqual(EXPORT_BATCH_ROWS);
    expect(got.rows[EXPORT_MAX_ROWS - 1]![0]).toBe(String(EXPORT_MAX_ROWS));
  }, 120_000);

  it("stops when the consumer says enough, and says it was cut by size", async () => {
    const got = await read("big", {}, 2500);
    // It stops at the end of the batch that filled it (batches are sized by what they hold).
    expect(got.rows.length).toBeGreaterThanOrEqual(2500);
    expect(got.rows.length).toBeLessThan(4000);
    expect(got.end).toMatchObject({ rows: got.rows.length, cut: "bytes" });
  });

  it("stops without an end when the consumer aborts, and holds no cursor afterwards", async () => {
    const signal = { aborted: false };
    const got: string[] = [];
    await adapter.exportRows(
      { schema: "public", name: "big" },
      { revealColumns: [] },
      (event) => {
        got.push(event.kind);
        if (event.kind === "rows") signal.aborted = true;
        return undefined;
      },
      signal,
    );
    expect(got).toEqual(["start", "rows"]);
    // The connection is usable straight away: the read-only transaction was closed.
    expect((await read("people")).rows).toHaveLength(4);
    const before = await read("people", {}, undefined, { aborted: true });
    expect(before.order).toEqual([]);
  });

  it("says what is wrong with the table, and what a throwing consumer does", async () => {
    expect(await code(read("missing_table"))).toBe("not_found");
    let thrown = "";
    try {
      await adapter.exportRows({ schema: "public", name: "people" }, { revealColumns: [] }, () => {
        throw new Error("consumer went away");
      });
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).toBeTruthy();
    // And the next export on the same adapter works.
    expect((await read("people")).rows).toHaveLength(4);
  });

  it("changes nothing", async () => {
    await read("people");
    expect((await client.query("SELECT count(*)::int AS n FROM people")).rows[0].n).toBe(4);
  });

  describe("what the review of 1.8.0 found", () => {
    it("exports every column of a wide table, not the first hundred", async () => {
      const names = Array.from({ length: 121 }, (_, i) => `col${i}`);
      await client.query(
        `CREATE TABLE wide121 (${names.map((n, i) => `${n} int${i === 0 ? " PRIMARY KEY" : ""}`).join(", ")})`,
      );
      await client.query(`INSERT INTO wide121 VALUES (${names.map((_, i) => i).join(", ")})`);
      const got = await read("wide121");
      expect(got.columns).toHaveLength(121);
      expect(got.rows[0]).toHaveLength(121);
      expect(got.rows[0]![120]).toBe("120");
    });

    it("sizes a batch by what it holds: 300 million characters are never read in one fetch", async () => {
      const got = await read("heavy");
      expect(got.rows).toHaveLength(150);
      // Two cells of a million characters per row: the first fetch is small and the rest take a few rows each,
      // never the 1,000 of a plain table (which would be a gigabyte in memory).
      expect(got.biggestBatch).toBeLessThanOrEqual(10);
      expect(got.batches).toBeGreaterThanOrEqual(40);
      expect(got.end).toMatchObject({ rows: 150, cut: null, cellsCut: 0 });
    }, 60_000);

    it("says `cut` only when the table really has more rows than the consumer took", async () => {
      // The consumer is full after the only batch: nothing was left, so the file is not cut.
      const whole = await read("two_rows", {}, 1);
      expect(whole.rows).toHaveLength(2);
      expect(whole.end).toMatchObject({ rows: 2, cut: null });
      // And when more is left it says so.
      const part = await read("big", {}, 1);
      expect(part.end).toMatchObject({ cut: "bytes" });
    });

    it("orders by the table's key even when a column is named like an output alias", async () => {
      const got = await read("aliases");
      expect(got.rows.map((r) => r[1])).toEqual(["1", "2", "3"]);
      const sorted = await read("aliases", { sort: { column: "r", direction: "asc" } });
      expect(sorted.rows.map((r) => r[1])).toEqual(["3", "2", "1"]);
      // The page reader shares the statement: the same order, and paging over it neither skips nor repeats.
      const page = await adapter.getRows(
        { schema: "public", name: "aliases" },
        { pageSize: 2, cursor: null, revealColumns: [] },
      );
      expect(page.rows.map((r) => r[1]!.value)).toEqual(["1", "2"]);
      const next = await adapter.getRows(
        { schema: "public", name: "aliases" },
        { pageSize: 2, cursor: page.nextCursor, revealColumns: [] },
      );
      expect(next.rows.map((r) => r[1]!.value)).toEqual(["3"]);
    });
  });
});
