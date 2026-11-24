/**
 * An export of chosen rows against a real PostgreSQL (1.10.0, V5; decision 168): the rows are named by the table's
 * WHOLE key, read by the page reader's own statement (every rule of a hidden column and of a cut value applies), a
 * key that matches nothing gives nothing, and what is not a key, a hidden key column, a table without a key, too many
 * keys and a value that does not fit are refused with a fixed message that names no value.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import { DatabaseError, EXPORT_MAX_KEYS, type ExportRowsOptions } from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SECRET = "hunter2-SECRET-VALUE";

const SQL = `
  CREATE TABLE k_people (id int PRIMARY KEY, name text, token text);
  INSERT INTO k_people SELECT i, 'name ' || i, 'tok-' || i FROM generate_series(1, 50) i;
  CREATE TABLE k_composite (a int, b text, v text, PRIMARY KEY (a, b));
  INSERT INTO k_composite VALUES (1, 'x', 'one-x'), (1, 'y', 'one-y'), (2, 'x', 'two-x'), (2, 'y', 'two-y');
  CREATE TABLE k_nokey (v text);
  INSERT INTO k_nokey VALUES ('a'), ('b');
  CREATE TABLE k_secretkey (api_token text PRIMARY KEY, v text);
  INSERT INTO k_secretkey VALUES ('${SECRET}', 'one'), ('other', 'two');
  CREATE TABLE k_long (id int PRIMARY KEY, t text);
  INSERT INTO k_long VALUES (1, repeat('x', 5000));
  CREATE TABLE k_text (code text PRIMARY KEY, v int);
  INSERT INTO k_text VALUES ('a'';b', 1), ('c', 2);
`;

describe.skipIf(!testDatabaseUrl())("an export of chosen rows", () => {
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
  }, 60_000);
  afterAll(async () => {
    await adapter?.disconnect();
    await client?.end().catch(() => {});
    await db?.dispose().catch(() => {});
  });

  const k = (pairs: Record<string, string>) =>
    Object.entries(pairs).map(([column, value]) => ({ column, value }));
  const read = async (table: string, options: Partial<ExportRowsOptions>) => {
    const rows: Array<Array<string | null>> = [];
    let columns: string[] = [];
    let leftOut: string[] = [];
    await adapter.exportRows(
      { schema: "public", name: table },
      { revealColumns: [], ...options },
      (event) => {
        if (event.kind === "start") {
          columns = event.columns.map((c) => c.name);
          leftOut = event.leftOut;
        } else if (event.kind === "rows") rows.push(...event.rows);
        return undefined;
      },
    );
    return { rows, columns, leftOut };
  };
  async function refusal(work: Promise<unknown>): Promise<DatabaseError> {
    const error = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DatabaseError);
    for (const text of [(error as Error).message, JSON.stringify(error), String(error)]) {
      expect(text).not.toContain(SECRET);
    }
    return error as DatabaseError;
  }

  it("gives exactly the chosen rows, in key order, and nothing else", async () => {
    const got = await read("k_people", { keys: [k({ id: "7" }), k({ id: "3" }), k({ id: "40" })] });
    expect(got.rows.map((r) => r[0])).toEqual(["3", "7", "40"]);
    // The hidden column is left out and named, as in any export of the table.
    expect(got.leftOut).toEqual(["token"]);
    expect(got.columns).toEqual(["id", "name"]);
  });

  it("a key that matches no row gives no row, and a list of none gives an empty file", async () => {
    expect((await read("k_people", { keys: [k({ id: "999" })] })).rows).toEqual([]);
    const some = await read("k_people", { keys: [k({ id: "1" }), k({ id: "999" })] });
    expect(some.rows.map((r) => r[0])).toEqual(["1"]);
  });

  it("names a composite key by all of its columns, in any order", async () => {
    const got = await read("k_composite", {
      keys: [k({ a: "2", b: "y" }), k({ b: "x", a: "1" })],
    });
    expect(got.rows.map((r) => r[2])).toEqual(["one-x", "two-y"]);
  });

  it("binds every value: a key that looks like SQL is a value", async () => {
    const got = await read("k_text", { keys: [k({ code: "a';b" }), k({ code: "x' OR '1'='1" })] });
    expect(got.rows.map((r) => r[1])).toEqual(["1"]);
  });

  it("reads the whole value of a long cell, as an export does (up to its own limit), never the grid's cut", async () => {
    const got = await read("k_long", { keys: [k({ id: "1" })] });
    expect(got.rows[0]![1]).toHaveLength(5000);
  });

  it("refuses a part of a key, a column that is not the key, a repeated column and an unknown one", async () => {
    for (const keys of [
      [k({ a: "1" })],
      [k({ a: "1", b: "x", v: "one-x" })],
      [[...k({ a: "1", b: "x" }), ...k({ a: "2" })]],
      [k({ a: "1", zzz: "x" })],
      [k({ v: "one-x" })],
    ]) {
      expect((await refusal(read("k_composite", { keys }))).code).toBe("invalid_request");
    }
    expect((await refusal(read("k_people", { keys: [k({ name: "name 1" })] }))).code).toBe(
      "invalid_request",
    );
  });

  it("refuses a table without a key, a key column that looks sensitive, an empty list and too many keys", async () => {
    expect((await refusal(read("k_nokey", { keys: [k({ v: "a" })] }))).code).toBe("not_supported");
    expect((await refusal(read("k_secretkey", { keys: [k({ api_token: SECRET })] }))).code).toBe(
      "invalid_request",
    );
    expect((await refusal(read("k_people", { keys: [] }))).code).toBe("invalid_request");
    const many = Array.from({ length: EXPORT_MAX_KEYS + 1 }, (_, i) => k({ id: String(i) }));
    expect((await refusal(read("k_people", { keys: many }))).code).toBe("invalid_request");
    // Exactly the limit is fine.
    const limit = Array.from({ length: EXPORT_MAX_KEYS }, (_, i) => k({ id: String(i + 1) }));
    expect((await read("k_people", { keys: limit })).rows).toHaveLength(
      EXPORT_MAX_KEYS > 50 ? 50 : EXPORT_MAX_KEYS,
    );
  });

  it("a sensitive key column is read when it was revealed", async () => {
    const got = await read("k_secretkey", {
      keys: [k({ api_token: "other" })],
      revealColumns: ["api_token"],
    });
    expect(got.rows).toEqual([["other", "two"]]);
  });

  it("a value that does not fit the type of the key is refused with a fixed message that does not repeat it", async () => {
    const error = await refusal(read("k_people", { keys: [k({ id: `not-a-number-${SECRET}` })] }));
    expect(error.code).toBe("invalid_request");
  });
});
