/**
 * The generated join SQL, run for real.
 *
 * For every ordered pair of tables in the sample shop and in the awkward
 * schema (quoted and Unicode names, composite and circular keys, partitions),
 * find the shortest route and EXECUTE the SQL we would show the user, on a
 * throwaway PostgreSQL. A syntax or quoting mistake anywhere would be a
 * database error here. (DataCanvas itself never runs this SQL; the test does
 * so only to prove the text is valid.)
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresAdapter } from "@datacanvas/postgres-adapter";
import {
  createTestDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from "@datacanvas/postgres-adapter/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildJoinSql, findPaths, type TableKey } from "./path-finder";

const oddSql = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/odd-schema.sql"),
  "utf8",
);

describe.skipIf(!testDatabaseUrl())("generated join SQL against a real PostgreSQL", () => {
  let db: TestDatabase;
  let client: pg.Client;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    client = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await client.connect();
    await client.query(oddSql);
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
  }, 60_000);

  afterAll(async () => {
    await adapter?.disconnect();
    await client?.end();
    await db?.dispose();
  }, 60_000);

  it("every route between any two tables is valid, runnable SQL", async () => {
    const schemas = (await adapter.getSchemas()).map((s) => s.name);
    const tables: TableKey[] = [];
    for (const schema of schemas) {
      for (const t of await adapter.getTables(schema)) {
        if (t.kind === "table") tables.push({ schema, table: t.name });
      }
    }
    const relationships = await adapter.getRelationships();
    expect(tables.length).toBeGreaterThan(30);

    let executed = 0;
    let connectedPairs = 0;
    for (const from of tables) {
      for (const to of tables) {
        const result = findPaths(relationships, from, to);
        if (result.status !== "found") continue;
        connectedPairs += 1;
        for (const route of result.paths) {
          // A failure names the SQL, so a quoting bug is easy to read.
          const sql = buildJoinSql(route);
          await client.query(sql).catch((error: unknown) => {
            throw new Error(`SQL failed: ${String(error)}\n${sql}`);
          });
          executed += 1;
        }
      }
    }
    console.info(
      `[paths] ${tables.length} tables, ${connectedPairs} connected pairs, ${executed} routes executed`,
    );
    // The fixtures contain several connected components with awkward names, so many pairs connect.
    expect(connectedPairs).toBeGreaterThan(40);
    expect(executed).toBeGreaterThanOrEqual(connectedPairs);
  }, 120_000);

  it("a join over real rows returns the rows the foreign keys imply", async () => {
    await client.query(`
      INSERT INTO public.fk_unique_target (id, code) VALUES (1, 'a'), (2, 'b');
      INSERT INTO public.fk_by_code (id, code) VALUES (10, 'a'), (11, 'a'), (12, 'b');
      INSERT INTO public.one_to_one (id) VALUES (1);
    `);
    const relationships = await adapter.getRelationships();
    const found = findPaths(
      relationships,
      { schema: "public", table: "fk_by_code" },
      { schema: "public", table: "one_to_one" },
    );
    if (found.status !== "found") throw new Error("expected a route");
    expect(found.length).toBe(2);
    const { rows } = await client.query(buildJoinSql(found.paths[0] as never));
    // fk_by_code(code) -> fk_unique_target(code) <- one_to_one(id = id): only target id 1 ('a') has a one_to_one row.
    expect(rows).toHaveLength(2); // fk_by_code rows 10 and 11 (both 'a')
  });
});
