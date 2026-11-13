/**
 * Performance check: a schema with several hundred tables.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set (see the integration test for
 * how to start a disposable server). Builds 600 tables (each with 8 columns, a
 * primary key and an index, and a foreign key to an earlier table), then times
 * the calls the UI makes on a big database. The budgets are deliberately
 * generous for a local server (measured: 5-25 ms each). They flag a large
 * regression, not a small one, and a slow CI machine may need them raised.
 *
 * ISOLATION: runs in its own throwaway database, like the integration tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const TABLES = 600;

/** Wall-clock milliseconds taken by `work`. */
async function time<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await work();
  return { ms: Math.round(performance.now() - start), value };
}

describe.skipIf(!testDatabaseUrl())(`PostgresAdapter with ${TABLES} tables`, () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    db = await createTestDatabase();
    const statements: string[] = ["CREATE SCHEMA big;"];
    for (let i = 0; i < TABLES; i += 1) {
      const reference =
        i === 0 ? "" : `, parent_id integer REFERENCES big.t${Math.max(0, i - 1 - (i % 7))}(id)`;
      statements.push(
        `CREATE TABLE big.t${i} (id integer PRIMARY KEY, name text, a int, b int, c int, d int, created timestamptz${reference});`,
        `CREATE INDEX t${i}_name_idx ON big.t${i}(name);`,
      );
    }
    const { default: pg } = await import("pg");
    const client = new pg.Client({
      host: db.connection.host,
      port: db.connection.port,
      user: db.connection.username,
      password: db.connection.password,
      database: db.dbName,
      ssl: db.connection.sslMode === "disable" ? false : undefined,
    });
    await client.connect();
    try {
      await client.query(statements.join("\n"));
    } finally {
      await client.end();
    }
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
  }, 120_000);

  afterAll(async () => {
    await adapter?.disconnect();
    await db?.dispose();
  }, 60_000);

  it("lists all tables of a big schema quickly", async () => {
    const { ms, value } = await time(() => adapter.getTables("big"));
    expect(value).toHaveLength(TABLES);
    expect(ms).toBeLessThan(500);
  });

  it("returns every relationship in one call", async () => {
    const { ms, value } = await time(() => adapter.getRelationships());
    expect(value.length).toBeGreaterThanOrEqual(TABLES - 1);
    expect(ms).toBeLessThan(500);
  });

  it("loads details for 200 tables at once (bulk, not one query per table)", async () => {
    const refs = Array.from({ length: 200 }, (_, i) => ({ schema: "big", name: `t${i}` }));
    const { ms, value } = await time(() => adapter.getTablesDetails(refs));
    expect(value).toHaveLength(200);
    expect(ms).toBeLessThan(1000);
  });

  it("searches a big schema quickly", async () => {
    const { ms, value } = await time(() => adapter.searchObjects("t5", 50));
    expect(value.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
  });
});
