/**
 * `getIndexUsage()` against a real PostgreSQL: which indexes are listed, what
 * is flagged as backing a constraint, sizes, the reset time and the standby
 * flag, and that a used index's counter really goes up.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set (see the integration test).
 * Runs in its own throwaway database.
 */
import type { IndexUsageReport } from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SQL = `
  CREATE TABLE iu_things (
    id    integer PRIMARY KEY,
    code  text NOT NULL UNIQUE,
    owner integer,
    note  text,
    span  int4range,
    CONSTRAINT iu_no_overlap EXCLUDE USING gist (span WITH &&)
  );
  CREATE INDEX iu_owner_idx ON iu_things (owner);
  CREATE UNIQUE INDEX iu_note_unique ON iu_things (note);
  INSERT INTO iu_things (id, code, owner, note) SELECT g, 'c' || g, g, 'n' || g FROM generate_series(1, 200) g;

  CREATE TABLE iu_events (id integer, d date) PARTITION BY RANGE (d);
  CREATE TABLE iu_events_2026 PARTITION OF iu_events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
  CREATE INDEX iu_events_d_idx ON iu_events (d);

  CREATE MATERIALIZED VIEW iu_mv AS SELECT id FROM iu_things;
  CREATE INDEX iu_mv_idx ON iu_mv (id);
`;

describe.skipIf(!testDatabaseUrl())("PostgresAdapter.getIndexUsage", () => {
  let db: TestDatabase;
  let adapter: PostgresAdapter;
  let report: IndexUsageReport;
  let resetAt: number;

  const connect = (): pg.Client => {
    const { host, port, username, password } = db.connection;
    return new pg.Client({ host, port, user: username, password, database: db.dbName });
  };
  const find = (r: IndexUsageReport, index: string) => r.indexes.find((i) => i.index === index);

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = connect();
    await client.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS btree_gist");
      await client.query(SQL);
      await client.query("ANALYZE iu_things");
      await client.query("SELECT pg_stat_reset()");
      // The server's own clock, not this machine's: the two can differ.
      const { rows } = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      resetAt = rows[0]!.now.getTime();
    } finally {
      await client.end();
    }
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
    report = await adapter.getIndexUsage();
    // Before PostgreSQL 15 the statistics collector applies a reset a moment later, so the time of the reset can still be
    // empty on the first read (it failed on 12 and 13 in CI): ask again for up to ten seconds.
    for (let attempt = 0; attempt < 40 && report.statsReset === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      report = await adapter.getIndexUsage();
    }
  });

  afterAll(async () => {
    await adapter?.disconnect();
    await db?.dispose();
  });

  it("lists the indexes of ordinary tables with a size and a scan count", () => {
    for (const name of ["iu_things_pkey", "iu_things_code_key", "iu_owner_idx", "iu_note_unique"]) {
      const usage = find(report, name);
      expect(usage, name).toMatchObject({ schema: "public", table: "iu_things", valid: true });
      expect(usage!.sizeBytes).toBeGreaterThan(0);
      expect(Number.isInteger(usage!.scans) && usage!.scans >= 0).toBe(true);
    }
  });

  it("says which indexes back a primary key, unique or exclusion constraint", () => {
    expect(find(report, "iu_things_pkey")!.backsConstraint).toBe(true);
    expect(find(report, "iu_things_code_key")!.backsConstraint).toBe(true);
    expect(find(report, "iu_no_overlap")!.backsConstraint).toBe(true);
    // A plain index, and a unique index made with CREATE UNIQUE INDEX (no constraint row), are not.
    expect(find(report, "iu_owner_idx")!.backsConstraint).toBe(false);
    expect(find(report, "iu_note_unique")!.backsConstraint).toBe(false);
  });

  it("leaves out partitions' indexes and the parent's, and indexes of views", () => {
    const names = report.indexes.map((i) => i.index);
    expect(names.filter((n) => n.startsWith("iu_events"))).toEqual([]);
    expect(names).not.toContain("iu_mv_idx");
  });

  it("reports when the counters were reset, and that this is not a standby", () => {
    expect(report.inRecovery).toBe(false);
    expect(report.statsReset).not.toBeNull();
    const reset = new Date(report.statsReset!).getTime();
    expect(Math.abs(reset - resetAt)).toBeLessThan(60_000);
  });

  it("counts a use of an index (counters are flushed when the using session ends)", async () => {
    const before = find(report, "iu_owner_idx")!.scans;
    const client = connect();
    await client.connect();
    try {
      await client.query("SET enable_seqscan = off");
      await client.query("SELECT * FROM iu_things WHERE owner = 7");
    } finally {
      await client.end();
    }
    let scans = before;
    for (let attempt = 0; attempt < 40 && scans <= before; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      scans = find(await adapter.getIndexUsage(), "iu_owner_idx")!.scans;
    }
    expect(scans).toBeGreaterThan(before);
  }, 20_000);

  it("never returns indexes of system schemas", () => {
    expect(
      report.indexes.filter((i) => i.schema.startsWith("pg_") || i.schema === "information_schema"),
    ).toEqual([]);
  });
});
