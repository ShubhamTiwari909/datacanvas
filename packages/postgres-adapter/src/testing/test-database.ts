/**
 * Test support: create a throwaway PostgreSQL database for integration tests.
 *
 * Imported as `@datacanvas/postgres-adapter/testing`. It is a separate entry
 * point so production code never pulls it in.
 *
 * It needs a disposable PostgreSQL SERVER (see examples/docker-compose.yml) and
 * the variable DATACANVAS_TEST_PG_URL pointing at that server's `postgres`
 * database with an account that may create databases and roles.
 *
 * ISOLATION: every call creates its own uniquely named database, loads
 * examples/ecommerce.sql into it, and `dispose()` drops it again. Nothing else
 * on the server is read or modified. NEVER point the variable at a server whose
 * data you care about.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePostgresConnectionString,
  type ResolvedPostgresConnection,
} from "@datacanvas/shared-types";
import pg from "pg";

/** The admin URL from the environment, or undefined (tests then skip themselves). */
export function testDatabaseUrl(): string | undefined {
  return process.env.DATACANVAS_TEST_PG_URL || undefined;
}

export interface TestDatabase {
  /** Admin credentials pointing at the NEW database. Hand to a PostgresAdapter. */
  connection: ResolvedPostgresConnection;
  /** Random suffix shared by this database's name and any names tests derive from it. */
  suffix: string;
  dbName: string;
  /** Connected as the admin, to the server's maintenance database (for roles, pg_stat_activity...). */
  admin: pg.Client;
  /** Drop the database and close the admin connection. Disconnect your adapters first. */
  dispose(): Promise<void>;
}

/** Quote an identifier for the CREATE/DROP statements below (they cannot take parameters). */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const fixtureSql = (): string =>
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../examples/ecommerce.sql",
    ),
    "utf8",
  );

/**
 * Create the database and load the sample shop into it, plus three rows in
 * `users` (analysed, so row-count estimates are non-trivial).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const url = testDatabaseUrl();
  if (!url) throw new Error("DATACANVAS_TEST_PG_URL is not set.");
  const parsed = parsePostgresConnectionString(url);
  if (!parsed.ok) throw new Error(`DATACANVAS_TEST_PG_URL is not valid: ${parsed.message}`);

  const { host, port, username, password, sslMode, database } = parsed.value;
  const suffix = randomBytes(4).toString("hex");
  const dbName = `dc_test_${suffix}`;
  const ssl = sslMode === "disable" ? false : { rejectUnauthorized: sslMode === "verify-full" };

  const admin = new pg.Client({ host, port, user: username, password, database, ssl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
    const setup = new pg.Client({ host, port, user: username, password, database: dbName, ssl });
    await setup.connect();
    try {
      await setup.query(fixtureSql());
      await setup.query(`
        INSERT INTO users (email) VALUES ('a@x.test'), ('b@x.test'), ('c@x.test');
        ANALYZE users;
      `);
    } finally {
      await setup.end();
    }
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
    throw error;
  }

  return {
    connection: { name: "test", host, port, username, password, sslMode, database: dbName },
    suffix,
    dbName,
    admin,
    async dispose() {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
      await admin.end();
    },
  };
}
