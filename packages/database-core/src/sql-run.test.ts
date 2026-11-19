import { describe, expect, it } from "vitest";
import {
  checkStatementText,
  firstKeyword,
  isSqlRunnerAdapter,
  SQL_LIMITS,
  SqlStatementError,
} from "./sql-run.js";

const ok = (text: string) => checkStatementText(text).ok;

describe("checkStatementText", () => {
  it.each([
    "SELECT 1",
    "select * from t",
    "  \n\tSELECT 1;",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "VALUES (1), (2)",
    "TABLE users",
    "EXPLAIN SELECT 1",
    "EXPLAIN ANALYZE SELECT 1",
    "SHOW server_version",
    "(SELECT 1) UNION (SELECT 2)",
    "((select 1))",
    "-- a comment\nSELECT 1",
    "/* a comment */ SELECT 1",
    "/* nested /* comment */ still */ SELECT 1",
    "-- one\n-- two\n/* three */\nSELECT 1",
  ])("allows %j", (text) => expect(ok(text)).toBe(true));

  it.each([
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET a = 1",
    "DELETE FROM t",
    "DROP TABLE t",
    "CREATE TABLE t (a int)",
    "TRUNCATE t",
    "ALTER TABLE t ADD COLUMN b int",
    "COPY (SELECT 1) TO PROGRAM 'id'",
    "DO $$ BEGIN PERFORM 1; END $$",
    "CALL p()",
    "SET default_transaction_read_only = off",
    "BEGIN READ WRITE",
    "COMMIT",
    "ROLLBACK",
    "LISTEN x",
    "NOTIFY x",
    "LOCK TABLE t",
    "PREPARE p AS SELECT 1",
    "EXECUTE p",
    "DECLARE c CURSOR FOR SELECT 1",
    "GRANT ALL ON t TO u",
    "VACUUM",
    "-- select\nDROP TABLE t",
    "/* select */ DROP TABLE t",
    "(DROP TABLE t)",
    "1; SELECT 1",
    "; SELECT 1",
    "'SELECT'",
  ])("refuses %j with the plain sentence", (text) => {
    const result = checkStatementText(text);
    expect(result.ok).toBe(false);
  });

  it("says what to do for nothing, comments only, or an open comment", () => {
    expect(checkStatementText("")).toEqual({ ok: false, message: "Type a statement to run." });
    expect(checkStatementText("  -- nothing\n")).toEqual({
      ok: false,
      message: "Type a statement to run.",
    });
    expect(checkStatementText("/* never closed SELECT 1")).toMatchObject({ ok: false });
  });

  it.each([
    // The review found this: PostgreSQL ends a line comment at a carriage return, JavaScript's
    // check did not, so this read as `SHOW` here and as `COPY ... TO PROGRAM` there.
    "--\rCOPY (SELECT 1) TO PROGRAM 'id' /*\nSHOW x */",
    "--\rDO $$ BEGIN END $$ /*\nSELECT 1 */",
    "SELECT 1 --\r; COMMIT",
    "\rSELECT 1",
    "SELECT 1\r\nFROM t",
    "\fSELECT 1",
    "\vSELECT 1",
    "SELECT\u0001 1",
    "SELECT 1\u007f",
  ])("refuses a control character PostgreSQL reads differently: %j", (text) => {
    const result = checkStatementText(text);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining("control character") });
  });

  it("allows the tab and the line feed", () => {
    expect(checkStatementText("SELECT\t1\nFROM t\n").ok).toBe(true);
    expect(firstKeyword("\t\n select 1")).toBe("select");
  });

  it("does not count other white space as white space, as PostgreSQL does not", () => {
    // A no-break space is a letter of an identifier to PostgreSQL, so this is not a SELECT.
    expect(firstKeyword("\u00a0SELECT 1")).toBeNull();
    expect(checkStatementText("\u00a0SELECT 1").ok).toBe(false);
    expect(checkStatementText("\u2028SELECT 1").ok).toBe(false);
  });

  it("refuses a statement that is too long or holds a NUL", () => {
    expect(ok(`SELECT '${"x".repeat(SQL_LIMITS.maxTextChars)}'`)).toBe(false);
    expect(ok("SELECT '\u0000'")).toBe(false);
  });
});

describe("EXPLAIN", () => {
  it.each([
    "EXPLAIN SELECT 1",
    "explain analyze select 1",
    "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t",
    "EXPLAIN (ANALYZE true, FORMAT JSON) WITH x AS (SELECT 1) SELECT * FROM x",
    "EXPLAIN ANALYZE VERBOSE VALUES (1)",
    "EXPLAIN /* c */ ANALYZE -- c\n TABLE t",
    "EXPLAIN SELECT 'a'",
  ])("allows explaining a query: %s", (text) => expect(ok(text)).toBe(true));

  it.each([
    // PostgreSQL runs these under ANALYZE without its read-only check.
    "EXPLAIN ANALYZE CREATE TABLE t AS SELECT 1",
    "EXPLAIN (ANALYZE) CREATE TABLE t AS SELECT 1",
    "EXPLAIN ANALYZE CREATE MATERIALIZED VIEW m AS SELECT 1",
    "EXPLAIN ANALYZE SELECT * INTO t FROM x",
    "EXPLAIN (ANALYZE, VERBOSE) SELECT a INTO t FROM x",
    "EXPLAIN ANALYZE WITH w AS (SELECT 1) SELECT * INTO t FROM w",
    "explain analyze select 1 into t",
    "EXPLAIN ANALYZE INSERT INTO t VALUES (1)",
    "EXPLAIN ANALYZE UPDATE t SET a = 1",
    "EXPLAIN ANALYZE DELETE FROM t",
    "EXPLAIN ANALYZE EXECUTE p",
    "EXPLAIN ANALYZE DECLARE c CURSOR FOR SELECT 1",
    "EXPLAIN",
    "EXPLAIN ANALYZE",
    "EXPLAIN (ANALYZE SELECT 1",
    "EXPLAIN SELECT 'into'",
  ])("refuses: %s", (text) => {
    const result = checkStatementText(text);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining("EXPLAIN") });
  });
});

describe("the capability", () => {
  it("is detected by its method", () => {
    expect(isSqlRunnerAdapter({ runStatement: () => {} })).toBe(true);
    expect(isSqlRunnerAdapter({})).toBe(false);
    expect(isSqlRunnerAdapter(null)).toBe(false);
  });

  it("carries the code and position of the database's refusal", () => {
    const error = new SqlStatementError("42P01", "relation does not exist", 15);
    expect([error.code, error.position, error.message]).toEqual([
      "42P01",
      15,
      "relation does not exist",
    ]);
  });
});
