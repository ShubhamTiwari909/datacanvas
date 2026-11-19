/**
 * The oracle of Migration Studio (`docs/migration-studio-plan.md`, section 7): a migration is
 * right when, applied to the "from" database, the structure it reads back has NO difference from
 * the "to" database; and its rollback is right when, applied after it, the structure is the
 * "from" one again.
 *
 * A scenario is plain SQL: how the "from" database is made, how the "to" database is made, the
 * migration (`up`) and the rollback (`down`). Both databases are real PostgreSQL databases (the
 * test server's, one pair per scenario), loaded with the sample shop first, and their structures
 * are read the way the app reads them (`captureStructure`, including the detail only a migration
 * needs), so what the oracle compares is exactly what a person would see. Nothing here reads a row.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set.
 */
import {
  captureStructure,
  ddlDifferences,
  diffStructures,
  diffToMarkdown,
  type DatabaseStructure,
} from "@datacanvas/database-core";
import pg from "pg";
import { PostgresAdapter } from "../postgres.adapter.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";

export interface Scenario {
  name: string;
  /** Run on the first database after the sample shop: how the starting point differs from it. */
  from: string;
  /** Run on the second database after the sample shop: how the target looks. */
  to: string;
  /** The migration under test: SQL run on the first database. */
  up: string;
  /** The rollback under test, run on the first database after `up`; omitted when there is none. */
  down?: string;
  /** Statements that run after the setup and before the structure is read: rows, for a migration that meets data. */
  data?: string;
}

export interface RoundTripResult {
  /** What differs between the migrated database and the target; empty when the migration is right. */
  upDifferences: string[];
  /** What differs between the rolled-back database and the starting point; null when there was no rollback. */
  downDifferences: string[] | null;
}

const LIMITS = { maxTables: 20_000, maxObjectsPerKind: 100_000, schemaBatch: 8, detailsBatch: 100 };

async function run(db: TestDatabase, sql: string): Promise<void> {
  if (sql.trim() === "") return;
  const { host, port, username, password } = db.connection;
  const client = new pg.Client({ host, port, user: username, password, database: db.dbName });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function read(db: TestDatabase): Promise<DatabaseStructure> {
  const adapter = new PostgresAdapter(db.connection);
  await adapter.connect();
  try {
    return await captureStructure(adapter, LIMITS);
  } finally {
    await adapter.disconnect();
  }
}

/** The differences between two structures: in what the comparison sees, and in the detail only a migration needs. */
export function describeDifferences(
  before: DatabaseStructure,
  after: DatabaseStructure,
  labels: { before: string; after: string },
): string[] {
  const diff = diffStructures(before, after);
  const lines: string[] = [];
  if (!diff.isEmpty) lines.push(diffToMarkdown(diff, labels));
  // `objects` not compared would hide differences: both sides are read now, so they always are.
  if (!diff.objectsCompared) lines.push("the objects were not compared");
  if (before.ddl && after.ddl) lines.push(...ddlDifferences(before.ddl, after.ddl));
  else lines.push("the definition detail was not recorded on one side");
  return lines;
}

export async function runRoundTrip(scenario: Scenario): Promise<RoundTripResult> {
  const from = await createTestDatabase();
  let to: TestDatabase | undefined;
  try {
    to = await createTestDatabase();
    await run(from, scenario.from);
    await run(to, scenario.to);
    if (scenario.data) {
      await run(from, scenario.data);
      await run(to, scenario.data);
    }
    const start = await read(from);
    const target = await read(to);

    await run(from, scenario.up);
    const migrated = await read(from);
    const upDifferences = describeDifferences(migrated, target, {
      before: "after the migration",
      after: "the target",
    });

    let downDifferences: string[] | null = null;
    if (scenario.down !== undefined) {
      await run(from, scenario.down);
      const rolledBack = await read(from);
      downDifferences = describeDifferences(rolledBack, start, {
        before: "after the rollback",
        after: "the starting point",
      });
    }
    return { upDifferences, downDifferences };
  } finally {
    await from.dispose().catch(() => {});
    await to?.dispose().catch(() => {});
  }
}
