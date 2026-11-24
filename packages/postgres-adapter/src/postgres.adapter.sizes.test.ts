/**
 * `getSizes()` against a real PostgreSQL: the database size, the per-schema totals, the largest tables first, a
 * partitioned table that counts its partitions (and the partitions not listed on their own), a materialized view, a view
 * left out (no storage), the schema filter and the limit. No row is read: these are file sizes.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set (see the integration test). Runs in its own throwaway database.
 */
import type { DatabaseSizes } from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SQL = `
  CREATE TABLE sz_big (id integer PRIMARY KEY, note text);
  INSERT INTO sz_big SELECT g, repeat('x', 200) FROM generate_series(1, 5000) g;
  CREATE TABLE sz_small (id integer PRIMARY KEY);

  CREATE TABLE sz_events (id integer, d date) PARTITION BY RANGE (d);
  CREATE TABLE sz_events_2026 PARTITION OF sz_events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
  INSERT INTO sz_events SELECT g, '2026-06-01' FROM generate_series(1, 2000) g;
  CREATE INDEX sz_events_d_idx ON sz_events (d);

  CREATE MATERIALIZED VIEW sz_mv AS SELECT id FROM sz_big;
  CREATE VIEW sz_view AS SELECT id FROM sz_small;

  CREATE SCHEMA sz_other;
  CREATE TABLE sz_other.lonely (id integer);
  ANALYZE;
`;

describe.skipIf(!testDatabaseUrl())("PostgresAdapter.getSizes", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;
  let all: DatabaseSizes;

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    const client = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await client.connect();
    try {
      await client.query(SQL);
    } finally {
      await client.end();
    }
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
    all = await adapter.getSizes({ limit: 100 });
  });

  afterAll(async () => {
    await adapter?.disconnect();
    await db?.dispose();
  });

  const find = (sizes: DatabaseSizes, name: string) => sizes.tables.find((t) => t.name === name);

  it("gives the size of the whole database", () => {
    expect(all.databaseBytes).toBeGreaterThan(1_000_000);
  });

  it("lists tables largest first, with their heap and index sizes", () => {
    const totals = all.tables.map((t) => t.totalBytes);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(all.tables[0]!.name).toBe("sz_big");
    const big = find(all, "sz_big")!;
    expect(big).toMatchObject({ schema: "public", kind: "table" });
    expect(big.tableBytes).toBeGreaterThan(1_000_000);
    expect(big.indexBytes).toBeGreaterThan(0);
    expect(big.totalBytes).toBeGreaterThanOrEqual(big.tableBytes + big.indexBytes);
    expect(big.estimatedRows).toBe(5000);
  });

  it("counts a partitioned table's partitions toward it, and does not list the partitions", () => {
    const events = find(all, "sz_events")!;
    expect(events.kind).toBe("partitioned");
    expect(events.tableBytes).toBeGreaterThan(0);
    expect(events.indexBytes).toBeGreaterThan(0);
    expect(find(all, "sz_events_2026")).toBeUndefined();
  });

  it("lists a materialized view and leaves out a plain view", () => {
    expect(find(all, "sz_mv")!.kind).toBe("materialized");
    expect(find(all, "sz_view")).toBeUndefined();
  });

  it("totals each schema, and filters and limits on request", async () => {
    // The test database may hold schemas of its own (an empty one totals 0 bytes in 0 tables).
    expect(all.schemas.map((s) => s.schema)).toEqual(
      expect.arrayContaining(["public", "sz_other"]),
    );
    expect(
      all.schemas.some((s) => s.schema.startsWith("pg_") || s.schema === "information_schema"),
    ).toBe(false);
    expect(all.schemas.find((s) => s.schema === "sz_other")!.tables).toBe(1);
    const one = await adapter.getSizes({ schema: "sz_other", limit: 100 });
    expect(one.tables.map((t) => t.name)).toEqual(["lonely"]);
    expect(one.schemas.map((s) => s.schema)).toEqual(["sz_other"]);
    const top = await adapter.getSizes({ limit: 2 });
    expect(top.tables).toHaveLength(2);
    expect(top.tableCount).toBe(all.tableCount);
    // sz_big, sz_small, sz_events, sz_mv, sz_other.lonely (no partition, no view), and whatever the database had before.
    expect(all.tableCount).toBeGreaterThanOrEqual(5);
    expect(all.tables.filter((t) => t.name.startsWith("sz_") || t.name === "lonely")).toHaveLength(
      5,
    );
  });
});
