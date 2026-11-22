/**
 * `preflight()` against a real PostgreSQL (`docs/advanced-data-workspace-plan.md`, section 6.3): the
 * four kinds of check give the number of rows that would make a migration step fail; a table or column
 * that is not there is `missing`; names are checked against the catalog and quoted; a slow check is
 * `too_slow` without stopping the others; nothing but counts comes back.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import { PREFLIGHT_MAX_CHECKS, type PreflightCheck } from "@datacanvas/database-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPreflightQuery } from "./introspection/preflight.js";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SECRET = "hunter2-SECRET-VALUE";

const SQL = `
  CREATE TABLE parent (id int PRIMARY KEY);
  INSERT INTO parent VALUES (1), (2);
  CREATE TABLE child (id int, parent_id int, tag text, a int, b int);
  INSERT INTO child VALUES
    (1, 1, 'x', 1, 1), (2, 2, 'x', 1, 1), (3, 99, 'y', 2, NULL), (4, NULL, NULL, NULL, NULL),
    (5, 98, '${SECRET}', 3, 3), (5, NULL, NULL, NULL, NULL);
  CREATE TABLE empty_one (id int);
  CREATE TABLE "Odd ""Name" ("we""ird" int);
  INSERT INTO "Odd ""Name" VALUES (NULL), (1);
  CREATE VIEW child_view AS SELECT id FROM child;
  CREATE TABLE big (n int, m text);
  INSERT INTO big SELECT i, md5(i::text) FROM generate_series(1, 1500000) AS i;
  CREATE TABLE text_ref (k text);
  CREATE TABLE creds (id int PRIMARY KEY, password_hash text);
  INSERT INTO creds VALUES (1, 'h'), (2, 'h'), (3, NULL);
  CREATE TABLE known_hashes (password_hash text);
  INSERT INTO known_hashes VALUES ('h');
`;

describe.skipIf(!testDatabaseUrl())("PostgreSQL preflight", () => {
  let db: TestDatabase;
  let client: pg.Client;
  let adapter: PostgresAdapter;
  let slow: PostgresAdapter;

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    client = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await client.connect();
    await client.query(SQL);
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
    // A short limit: the catalog questions fit in it, a grouping of 1.5 million rows does not.
    slow = new PostgresAdapter(db.connection, { statementTimeoutMs: 50 });
    await slow.connect();
  }, 120_000);
  afterAll(async () => {
    await slow?.disconnect();
    await adapter?.disconnect();
    await client?.end().catch(() => {});
    await db?.dispose().catch(() => {});
  });

  const one = async (check: PreflightCheck) => (await adapter.preflight([check]))[0]!;
  const t = (name: string) => ({ schema: "public", table: name });

  it("counts the rows with NULL before SET NOT NULL", async () => {
    expect(await one({ kind: "nulls", ...t("child"), column: "parent_id" })).toEqual({
      status: "fails",
      count: 2,
    });
    expect(await one({ kind: "nulls", ...t("child"), column: "id" })).toEqual({
      status: "ok",
      count: 0,
    });
  });

  it("counts the values shared by several rows before a unique key, and a NULL never collides", async () => {
    // id 5 appears twice.
    expect(await one({ kind: "duplicates", ...t("child"), columns: ["id"] })).toEqual({
      status: "fails",
      count: 1,
    });
    // (a, b): (1,1) twice; (2,NULL), (3,3) and the all-NULL rows are not collisions.
    expect(await one({ kind: "duplicates", ...t("child"), columns: ["a", "b"] })).toEqual({
      status: "fails",
      count: 1,
    });
    expect(await one({ kind: "duplicates", ...t("child"), columns: ["tag", "id"] })).toEqual({
      status: "ok",
      count: 0,
    });
  });

  it("counts the rows with no parent before a foreign key, and leaves an empty reference alone", async () => {
    expect(
      await one({
        kind: "orphans",
        ...t("child"),
        columns: ["parent_id"],
        refSchema: "public",
        refTable: "parent",
        refColumns: ["id"],
      }),
    ).toEqual({ status: "fails", count: 2 }); // 99 and 98; NULL is not an orphan
  });

  it("says whether a table has rows before a column that cannot be NULL", async () => {
    expect(await one({ kind: "rows", ...t("child") })).toEqual({ status: "fails", count: 1 });
    expect(await one({ kind: "rows", ...t("empty_one") })).toEqual({ status: "ok", count: 0 });
  });

  it("answers `missing` for a table, a column or a referenced table that is not here, or is a view", async () => {
    const missing = { status: "missing", count: 0 };
    expect(await one({ kind: "nulls", ...t("nope"), column: "x" })).toEqual(missing);
    expect(await one({ kind: "nulls", ...t("child"), column: "nope" })).toEqual(missing);
    expect(await one({ kind: "rows", ...t("child_view") })).toEqual(missing);
    expect(
      await one({
        kind: "orphans",
        ...t("child"),
        columns: ["parent_id"],
        refSchema: "public",
        refTable: "nope",
        refColumns: ["id"],
      }),
    ).toEqual(missing);
    expect(
      await one({
        kind: "orphans",
        ...t("child"),
        columns: ["parent_id"],
        refSchema: "public",
        refTable: "parent",
        refColumns: ["nope"],
      }),
    ).toEqual(missing);
  });

  it("quotes names, so a name with a quote in it is a name and nothing more", async () => {
    expect(await one({ kind: "nulls", ...t('Odd "Name'), column: 'we"ird' })).toEqual({
      status: "fails",
      count: 1,
    });
    const hostile = await one({ kind: "nulls", ...t("child"), column: 'id" IS NULL OR 1=1 --' });
    expect(hostile.status).toBe("missing");
  });

  it("answers every check of a request, in order", async () => {
    const results = await adapter.preflight([
      { kind: "nulls", ...t("child"), column: "id" },
      { kind: "nulls", ...t("nope"), column: "x" },
      { kind: "rows", ...t("child") },
    ]);
    expect(results.map((r) => r.status)).toEqual(["ok", "missing", "fails"]);
  });

  it("refuses too many checks, a key with no columns, and a foreign key whose columns do not line up", async () => {
    const code = async (checks: PreflightCheck[]) => {
      try {
        await adapter.preflight(checks);
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return "(no error)";
    };
    const one: PreflightCheck = { kind: "rows", ...t("child") };
    expect(await code(Array.from({ length: PREFLIGHT_MAX_CHECKS + 1 }, () => one))).toBe(
      "invalid_request",
    );
    expect(await code([{ kind: "duplicates", ...t("child"), columns: [] }])).toBe(
      "invalid_request",
    );
    expect(await code([{ kind: "duplicates", ...t("child"), columns: ["id", "id"] }])).toBe(
      "invalid_request",
    );
    expect(
      await code([
        {
          kind: "orphans",
          ...t("child"),
          columns: ["a", "b"],
          refSchema: "public",
          refTable: "parent",
          refColumns: ["id"],
        },
      ]),
    ).toBe("invalid_request");
    // Columns that cannot be compared: a fixed code, never the database's message.
    expect(
      await code([
        {
          kind: "orphans",
          ...t("child"),
          columns: ["a"],
          refSchema: "public",
          refTable: "text_ref",
          refColumns: ["k"],
        },
      ]),
    ).toBe("invalid_request");
  });

  it("stops a check that takes too long and still answers the others", async () => {
    const results = await slow.preflight([
      { kind: "duplicates", ...t("big"), columns: ["m"] },
      { kind: "nulls", ...t("nope"), column: "x" },
    ]);
    expect(results.map((r) => r.status)).toEqual(["too_slow", "missing"]);
  });

  it("builds one fixed statement per kind, and no value is ever in a statement or an answer", async () => {
    for (const check of [
      { kind: "nulls", ...t("child"), column: "tag" },
      { kind: "duplicates", ...t("child"), columns: ["tag"] },
    ] satisfies PreflightCheck[]) {
      expect(buildPreflightQuery(check)).not.toContain(SECRET);
      expect(JSON.stringify(await one(check))).not.toContain(SECRET);
    }
    expect(buildPreflightQuery({ kind: "nulls", ...t("child"), column: "tag" })).toBe(
      'SELECT count(*)::text AS n FROM "public"."child" WHERE "tag" IS NULL',
    );
  });

  it("changes nothing", async () => {
    await adapter.preflight([{ kind: "rows", ...t("child") }]);
    expect((await client.query("SELECT count(*)::int AS n FROM child")).rows[0].n).toBe(6);
  });

  it("does not count on a hidden column: shared values, NULLs or a match with another table would read it back", async () => {
    const hidden = { status: "hidden", count: 0 };
    expect(await one({ kind: "duplicates", ...t("creds"), columns: ["password_hash"] })).toEqual(
      hidden,
    );
    expect(await one({ kind: "nulls", ...t("creds"), column: "password_hash" })).toEqual(hidden);
    expect(
      await one({
        kind: "orphans",
        ...t("creds"),
        columns: ["password_hash"],
        refSchema: "public",
        refTable: "known_hashes",
        refColumns: ["password_hash"],
      }),
    ).toEqual(hidden);
    // A plain column of the same table is still counted.
    expect(await one({ kind: "nulls", ...t("creds"), column: "id" })).toEqual({
      status: "ok",
      count: 0,
    });
  });
});
