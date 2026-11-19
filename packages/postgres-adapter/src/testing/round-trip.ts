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
  downScript,
  planMigration,
  suggestRenames,
  type DatabaseStructure,
  type MigrationPlan,
  type PlanOptions,
  type RenameSuggestion,
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

// ----------------------------------------------------------------- the planner

/**
 * A scenario for the planner (milestone M1): the planner makes the migration, so the scenario holds
 * only the two states. SQL may say `{s}` for the scenario's own schema, written as an identifier
 * (quoted), so many scenarios can share one pair of databases and not see each other.
 */
export interface PlanScenario {
  name: string;
  from: string;
  to: string;
  /** Rows (or anything else) added to both databases after their states are made, before they are read. */
  data?: string;
  /** Rows for the starting database only: for data that the target's own rules would refuse (a NOT NULL, a column that is not there). */
  fromData?: string;
  options?: PlanOptions;
  /** Which of the suggested renames to confirm (all of them by default when this is given as `true`). */
  confirm?: boolean | ((suggestion: RenameSuggestion) => boolean);
  /** Statements run in both databases afterwards, for what a dropped schema does not take (an extension). `{s}` and `{s2}` work here too. */
  cleanup?: string;
  /** The schema's name; by default a plain one. Hostile names are tested by choosing one. */
  schema?: string;
}

export interface PlanRoundTrip {
  plan: MigrationPlan;
  /** The step that failed when the migration ran, with the error: the plan was wrong. Null when it ran. */
  upError: string | null;
  upDifferences: string[];
  downError: string | null;
  downDifferences: string[];
}

export interface Pair {
  from: TestDatabase;
  to: TestDatabase;
}

let scenarioCounter = 0;

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Two databases for a whole file of scenarios. */
export async function createPair(): Promise<Pair> {
  const from = await createTestDatabase();
  try {
    return { from, to: await createTestDatabase() };
  } catch (error) {
    await from.dispose().catch(() => {});
    throw error;
  }
}

export async function disposePair(pair: Pair | undefined): Promise<void> {
  await pair?.from.dispose().catch(() => {});
  await pair?.to.dispose().catch(() => {});
}

async function execute(db: TestDatabase, statements: string[]): Promise<string | null> {
  const { host, port, username, password } = db.connection;
  const client = new pg.Client({ host, port, user: username, password, database: db.dbName });
  await client.connect();
  try {
    for (const sql of statements) {
      if (sql.trim() === "") continue;
      try {
        await client.query(sql);
      } catch (error) {
        return `${(error as Error).message}\n--- while running:\n${sql}`;
      }
    }
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runPlanScenario(pair: Pair, scenario: PlanScenario): Promise<PlanRoundTrip> {
  const schema = scenario.schema ?? `rt${++scenarioCounter}`;
  const second = `${schema}_x`;
  const sql = (text: string) =>
    text.replaceAll("{s2}", quote(second)).replaceAll("{s}", quote(schema));
  const cleanup = [
    `DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`,
    `DROP SCHEMA IF EXISTS ${quote(second)} CASCADE`,
  ];
  try {
    for (const [db, text, extra] of [
      [pair.from, scenario.from, `${scenario.data ?? ""} ${scenario.fromData ?? ""}`],
      [pair.to, scenario.to, scenario.data ?? ""],
    ] as const) {
      const error = await execute(db, [sql(text), sql(extra)]);
      if (error) throw new Error(`the scenario "${scenario.name}" could not be set up: ${error}`);
    }
    const start = await read(pair.from);
    const target = await read(pair.to);
    const confirm = scenario.confirm;
    const renames =
      confirm === undefined || confirm === false
        ? undefined
        : suggestRenames(start, target)
            .filter((r) => confirm === true || confirm(r))
            .map((r) => r.id);
    const plan = planMigration(start, target, {
      ...scenario.options,
      ...(renames ? { renames } : {}),
    });

    const upError = await execute(
      pair.from,
      plan.steps.map((step) => step.up),
    );
    const migrated = await read(pair.from);
    const upDifferences = describeDifferences(migrated, target, {
      before: "after the migration",
      after: "the target",
    });

    const downError = await execute(pair.from, [downScript(plan)]);
    const rolledBack = await read(pair.from);
    const downDifferences = describeDifferences(rolledBack, start, {
      before: "after the rollback",
      after: "the starting point",
    });
    return { plan, upError, upDifferences, downError, downDifferences };
  } finally {
    const after = scenario.cleanup === undefined ? [] : [sql(scenario.cleanup)];
    await execute(pair.from, [...cleanup, ...after]);
    await execute(pair.to, [...cleanup, ...after]);
  }
}
