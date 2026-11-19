/**
 * The SQL Workspace's runner against a real PostgreSQL (1.6.0, S1; decision 141 and
 * `docs/sql-workspace-plan.md` section 3.2): one statement, read-only, on a connection of
 * its own. Each way out of a read-only transaction that the plan names has a test here, and
 * they use the LOW-LEVEL function so the database's guard is tested without the first-word
 * check in front of it.
 *
 * Skipped unless DATACANVAS_TEST_PG_URL is set. Runs in its own throwaway database.
 */
import { DatabaseError, SqlStatementError, type SqlRunRequest } from "@datacanvas/database-core";
import net from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPoolConfig, resolveAdapterOptions } from "./connection/config.js";
import { runStatementOnOwnConnection } from "./connection/run-statement.js";
import { PostgresAdapter } from "./postgres.adapter.js";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./testing/index.js";

const SETUP = `
  CREATE TABLE t_rows (id int PRIMARY KEY, v text);
  INSERT INTO t_rows VALUES (1, 'one'), (2, 'two');
  CREATE FUNCTION sneaky() RETURNS int LANGUAGE plpgsql AS $$
    BEGIN SET LOCAL transaction_read_only = off; INSERT INTO t_rows VALUES (98, 'sneaky'); RETURN 1; END $$;
  CREATE FUNCTION writer() RETURNS int LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO t_rows VALUES (97, 'writer'); RETURN 1; END $$;
`;

describe.skipIf(!testDatabaseUrl())("the SQL runner", () => {
  let db: TestDatabase;
  let admin: pg.Client;
  let adapter: PostgresAdapter;
  let config: ReturnType<typeof buildPoolConfig>;

  const run = (text: string, extra: Partial<SqlRunRequest> = {}) =>
    runStatementOnOwnConnection(config, { text, maxRows: 1000, timeoutMs: 5000, ...extra });
  const viaAdapter = (text: string) =>
    adapter.runStatement({ text, maxRows: 100, timeoutMs: 5000 });
  const rowsOf = async () =>
    (await admin.query("SELECT id FROM t_rows ORDER BY id")).rows.map((r) => r.id as number);
  const refusal = async (work: Promise<unknown>): Promise<SqlStatementError> => {
    const error = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SqlStatementError);
    return error as SqlStatementError;
  };
  const sqlBackends = async () =>
    Number(
      (
        await admin.query(
          "SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = 'DataCanvas SQL'",
        )
      ).rows[0]?.n,
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    const { host, port, username, password } = db.connection;
    admin = new pg.Client({ host, port, user: username, password, database: db.dbName });
    await admin.connect();
    await admin.query(SETUP);
    adapter = new PostgresAdapter(db.connection);
    await adapter.connect();
    config = buildPoolConfig(db.connection, resolveAdapterOptions());
  }, 60_000);

  afterAll(async () => {
    await adapter?.disconnect();
    await admin?.end();
    await db?.dispose();
  });

  describe("results", () => {
    it("returns columns with their types and every value as text, NULL as null", async () => {
      const result = await run(
        `SELECT 1 AS n, 'a'::text AS t, NULL::int AS z, 1.50::numeric(10,2) AS price, true AS b, '{"a":1}'::jsonb AS j`,
      );
      expect(result.columns).toEqual([
        { name: "n", dataType: "integer" },
        { name: "t", dataType: "text" },
        { name: "z", dataType: "integer" },
        { name: "price", dataType: "numeric(10,2)" },
        { name: "b", dataType: "boolean" },
        { name: "j", dataType: "jsonb" },
      ]);
      expect(result.rows).toEqual([["1", "a", null, "1.50", "true", '{"a": 1}']]);
      expect(result.command).toBe("SELECT");
      expect(result.truncated).toBe(false);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("stops at the row cap and says there were more, reading one row past it", async () => {
      const capped = await run("SELECT g FROM generate_series(1, 1000) g", { maxRows: 10 });
      expect(capped.rows).toHaveLength(10);
      expect(capped.truncated).toBe(true);
      const exact = await run("SELECT g FROM generate_series(1, 1000) g", { maxRows: 1000 });
      expect(exact.rows).toHaveLength(1000);
      expect(exact.truncated).toBe(false);
    });

    it("cuts a long cell and counts the cut cells", async () => {
      const result = await run("SELECT repeat('a', 5000) AS big, 'short' AS small");
      expect(result.rows[0]?.[0]).toHaveLength(2000);
      expect(result.rows[0]?.[1]).toBe("short");
      expect(result.cutCells).toBe(1);
    });

    it("runs SHOW, EXPLAIN, VALUES and TABLE", async () => {
      expect((await run("SHOW server_version")).rows).toHaveLength(1);
      expect((await run("EXPLAIN SELECT * FROM t_rows")).rows.length).toBeGreaterThan(0);
      expect((await run("VALUES (1), (2)")).rows).toEqual([["1"], ["2"]]);
      expect((await run("TABLE t_rows")).rows).toEqual([
        ["1", "one"],
        ["2", "two"],
      ]);
    });

    it("reports a failure with the database's sentence and the position in the text", async () => {
      const error = await refusal(run("SELECT * FROM nope"));
      expect([error.code, error.position]).toEqual(["42P01", 15]);
      expect(error.message).toContain("nope");
      expect(error.message).not.toContain(db.connection.password ?? "no-password");
    });
  });

  describe("the ways out of a read-only transaction", () => {
    it("refuses several statements in one text, so a COMMIT inside it cannot end the transaction", async () => {
      for (const text of [
        "SELECT 1; SELECT 2",
        "SELECT 1; COMMIT; INSERT INTO t_rows VALUES (99, 'escaped')",
        "SELECT 1; ROLLBACK; DROP TABLE t_rows",
        "SHOW server_version; COMMIT; DROP TABLE t_rows",
      ]) {
        expect((await refusal(run(text))).code).toBe("42601");
      }
      expect(await rowsOf()).toEqual([1, 2]);
    });

    it("lets the database refuse every write", async () => {
      for (const text of [
        "INSERT INTO t_rows VALUES (50, 'x')",
        "UPDATE t_rows SET v = 'changed'",
        "DELETE FROM t_rows",
        "TRUNCATE t_rows",
        "CREATE TABLE t_new (a int)",
        "DROP TABLE t_rows",
        "ALTER TABLE t_rows ADD COLUMN extra int",
        "WITH x AS (INSERT INTO t_rows VALUES (51, 'x') RETURNING id) SELECT * FROM x",
        "SELECT writer()",
      ]) {
        const error = await refusal(run(text));
        // A cursor refuses a data-changing WITH before the read-only check does: either way it is refused.
        expect([text, ["25006", "0A000"].includes(error.code)]).toEqual([text, true]);
      }
      expect(await rowsOf()).toEqual([1, 2]);
      expect((await admin.query("SELECT v FROM t_rows WHERE id = 1")).rows[0]?.v).toBe("one");
    });

    it("refuses to switch to read-write, from a statement or from inside a function", async () => {
      expect(["25006", "25001"]).toContain((await refusal(run("SET TRANSACTION READ WRITE"))).code);
      const error = await refusal(run("SELECT sneaky()"));
      expect(["25006", "25001"]).toContain(error.code);
      expect(await rowsOf()).toEqual([1, 2]);
    });

    it("lets a lone COMMIT or ROLLBACK end nothing that matters", async () => {
      await run("COMMIT");
      await run("ROLLBACK");
      // The next run is a new connection with a new read-only transaction.
      expect((await refusal(run("INSERT INTO t_rows VALUES (52, 'x')"))).code).toBe("25006");
      expect(await rowsOf()).toEqual([1, 2]);
    });

    it("lets no session setting outlive the run, and closes its connection", async () => {
      await run("SET SESSION default_transaction_read_only = off");
      expect((await run("SHOW default_transaction_read_only")).rows).toEqual([["on"]]);
      expect((await refusal(run("INSERT INTO t_rows VALUES (53, 'x')"))).code).toBe("25006");
      // The throwaway connections are gone, and nothing of the pool changed.
      for (let i = 0; i < 20 && (await sqlBackends()) > 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await sqlBackends()).toBe(0);
      expect((await admin.query("SHOW default_transaction_read_only")).rows[0]).toEqual({
        default_transaction_read_only: "off",
      });
    });
  });

  describe("EXPLAIN ANALYZE runs the statement it explains", () => {
    it("is not allowed to explain what would create a table: PostgreSQL does not stop that itself", async () => {
      const creating = [
        "EXPLAIN ANALYZE CREATE TABLE t_ctas AS SELECT 1 AS a",
        "EXPLAIN (ANALYZE) CREATE TABLE t_ctas2 AS SELECT * FROM t_rows",
        "EXPLAIN ANALYZE SELECT * INTO t_into FROM t_rows",
        "EXPLAIN (ANALYZE) CREATE MATERIALIZED VIEW t_mv AS SELECT 1 AS a",
      ];
      for (const text of creating) {
        const error = await refusal(viaAdapter(text));
        expect([text, error.code]).toEqual([text, "not_allowed"]);
      }
      const made = await admin.query(
        "SELECT relname FROM pg_class WHERE relname IN ('t_ctas', 't_ctas2', 't_into', 't_mv')",
      );
      expect(made.rows).toEqual([]);
    });

    it("leaves what the database stops by itself to the database", async () => {
      for (const text of [
        "EXPLAIN ANALYZE INSERT INTO t_rows VALUES (70, 'x')",
        "EXPLAIN ANALYZE UPDATE t_rows SET v = 'changed'",
        "EXPLAIN ANALYZE DELETE FROM t_rows",
      ]) {
        // Refused by the check here; the database would refuse them in its read-only transaction too.
        expect((await refusal(viaAdapter(text))).code).toBe("not_allowed");
      }
      const writing = await refusal(viaAdapter("EXPLAIN ANALYZE SELECT writer()"));
      expect(writing.code).toBe("25006");
      expect(await rowsOf()).toEqual([1, 2]);
    });

    it("still explains a query, with its real times", async () => {
      const result = await viaAdapter("EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t_rows");
      expect(result.rows.map((r) => r[0]).join("\n")).toContain("Execution Time");
    });
  });

  describe("how much is read", () => {
    // The budget is the product's 64 MB; these use a small one, so the tests do not make the server work for it.
    const budgeted = (text: string, bytes: number) =>
      runStatementOnOwnConnection(config, { text, maxRows: 1000, timeoutMs: 30_000 }, bytes);

    it("stops at a byte budget, however large the rows, and says there was more", async () => {
      // 100 rows of 200 KB: 20 MB if all were read; the budget here is 1 MB.
      const result = await budgeted(
        "SELECT repeat('x', 200000) AS big, g FROM generate_series(1, 100) g",
        1_000_000,
      );
      expect(result.truncated).toBe(true);
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      expect(result.rows.length).toBeLessThanOrEqual(6);
      expect(result.cutCells).toBe(result.rows.length);
    });

    it("keeps at least the first row, however large it is", async () => {
      const result = await budgeted(
        "SELECT repeat('x', 3000000) AS big FROM generate_series(1, 3)",
        1000,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it("counts bytes, not characters: multibyte text reaches the budget sooner", async () => {
      // 400,000 characters of two bytes: 800 KB a row. Counted as characters two rows would fit in 1 MB.
      const result = await budgeted(
        "SELECT repeat('é', 400000) AS c FROM generate_series(1, 5)",
        1_000_000,
      );
      expect(result.truncated).toBe(true);
      expect(result.rows).toHaveLength(1);
    });

    it("does not call a result truncated that fits", async () => {
      const result = await run("SELECT repeat('x', 100000) AS big FROM generate_series(1, 20)");
      expect(result.truncated).toBe(false);
      expect(result.rows).toHaveLength(20);
    });
  });

  describe("cancelling", () => {
    it("ends the wait for a server that never answers, at once", async () => {
      const silent = net.createServer(() => {});
      await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
      const { port } = silent.address() as net.AddressInfo;
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 300);
        const started = Date.now();
        const error = await refusal(
          runStatementOnOwnConnection(
            { ...config, host: "127.0.0.1", port, connectionTimeoutMillis: 20_000 },
            { text: "SELECT 1", maxRows: 10, timeoutMs: 5000, signal: controller.signal },
          ),
        );
        expect(error.code).toBe("cancelled");
        // Not after the connect timeout.
        expect(Date.now() - started).toBeLessThan(3000);
      } finally {
        silent.close();
      }
    });

    it("cancels a statement that is fetched in batches, between two of them", async () => {
      const controller = new AbortController();
      const started = Date.now();
      const running = run("SELECT g, pg_sleep(0.02) FROM generate_series(1, 100000) g", {
        maxRows: 10_000,
        timeoutMs: 120_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 600);
      expect((await refusal(running)).code).toBe("cancelled");
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });

  describe("one time limit for the whole statement", () => {
    it("stops a statement that is fetched in many pieces, not after each piece has had its own limit", async () => {
      const started = Date.now();
      // Twenty rows, 0.3 s each: 6 s in all, fetched one at a time. The limit is 1.5 s for all of it.
      const error = await refusal(
        run("SELECT g, pg_sleep(0.3) FROM generate_series(1, 20) g", {
          timeoutMs: 1500,
          maxRows: 100,
        }),
      );
      expect(error.code).toBe("57014");
      expect(Date.now() - started).toBeLessThan(4500);
    });
  });

  describe("time", () => {
    it("stops a statement at the timeout", async () => {
      const started = Date.now();
      const error = await refusal(run("SELECT pg_sleep(5)", { timeoutMs: 300 }));
      expect(error.code).toBe("57014");
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it("cancels a running statement when the signal aborts, and leaves no backend behind", async () => {
      const controller = new AbortController();
      const started = Date.now();
      const running = run("SELECT pg_sleep(30)", { timeoutMs: 60_000, signal: controller.signal });
      setTimeout(() => controller.abort(), 300);
      const error = await refusal(running);
      expect(error.code).toBe("cancelled");
      expect(Date.now() - started).toBeLessThan(5000);
      for (let i = 0; i < 30 && (await sqlBackends()) > 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await sqlBackends()).toBe(0);
    });

    it("does not start when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      expect((await refusal(run("SELECT 1", { signal: controller.signal }))).code).toBe(
        "cancelled",
      );
    });
  });

  describe("what the first-word check and PostgreSQL's lexer must agree on", () => {
    it("shows the difference the check had to close: PostgreSQL ends a line comment at a carriage return", async () => {
      // Here the low-level function sends the text as it is. JavaScript would see one comment,
      // up to the line feed; PostgreSQL sees an empty comment, and then a SELECT.
      const result = await run("--\rSELECT 42 AS answer /*\n comment */");
      expect(result.rows).toEqual([["42"]]);
    });

    it("refuses such text before it reaches the database, so nothing it hides can run", async () => {
      for (const text of [
        "--\rCOPY (SELECT 1) TO PROGRAM 'touch /tmp/dc-should-not-exist' /*\nSHOW x */",
        "--\rDO $$ BEGIN PERFORM 1; END $$ /*\nSHOW x */",
        "--\rCOMMIT /*\nSHOW x */",
        "SHOW x --\r; SELECT 1",
        "\u000cCOPY (SELECT 1) TO PROGRAM 'id'",
      ]) {
        const error = await refusal(viaAdapter(text));
        expect([text, error.code]).toEqual([text, "not_allowed"]);
      }
    });
  });

  describe("through the adapter", () => {
    it("runs a read", async () => {
      expect((await viaAdapter("SELECT id FROM t_rows ORDER BY id")).rows).toEqual([["1"], ["2"]]);
    });

    it("refuses what a read-only transaction would let through, before it reaches the database", async () => {
      for (const text of [
        "COPY (SELECT 1) TO PROGRAM 'id'",
        "DO $$ BEGIN PERFORM 1; END $$",
        "CALL nothing()",
        "SET default_transaction_read_only = off",
        "BEGIN READ WRITE",
        "INSERT INTO t_rows VALUES (60, 'x')",
      ]) {
        const error = await refusal(viaAdapter(text));
        expect([text, error.code]).toEqual([text, "not_allowed"]);
      }
      expect(await rowsOf()).toEqual([1, 2]);
    });

    it("needs an open connection", async () => {
      const closed = new PostgresAdapter(db.connection);
      const error = await closed
        .runStatement({ text: "SELECT 1", maxRows: 1, timeoutMs: 1000 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(DatabaseError);
      expect((error as DatabaseError).code).toBe("not_connected");
    });

    it("maps a connection failure to a fixed message", async () => {
      const wrong = new PostgresAdapter({ ...db.connection, password: "definitely-wrong" });
      // Not connected, so it says so; a failed login is covered by the adapter's own connect tests.
      await expect(
        wrong.runStatement({ text: "SELECT 1", maxRows: 1, timeoutMs: 1000 }),
      ).rejects.toBeInstanceOf(DatabaseError);
    });
  });
});
