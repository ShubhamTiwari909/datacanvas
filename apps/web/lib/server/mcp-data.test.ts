import type { RowPage } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  CELL_CHARS,
  RESULT_CHARS,
  failureWords,
  sensitiveNamesIn,
  shapePage,
  shapeQueryResult,
} from "./mcp-data";

describe("the names in a statement that look sensitive", () => {
  it("finds a column named in the select list, the where clause, an alias, a function and a quoted identifier", () => {
    expect(sensitiveNamesIn("SELECT password FROM users")).toEqual(["password"]);
    expect(sensitiveNamesIn("SELECT id FROM users WHERE api_token = 'x'")).toEqual(["api_token"]);
    expect(sensitiveNamesIn("SELECT length(password_hash) AS n FROM users")).toEqual([
      "password_hash",
    ]);
    expect(sensitiveNamesIn('SELECT "apiKey", "Secret ""x""" FROM t')).toEqual([
      "apiKey",
      'Secret "x"',
    ]);
    expect(sensitiveNamesIn("SELECT u.secret_value, u.refresh_token FROM users u")).toEqual([
      "secret_value",
      "refresh_token",
    ]);
  });

  it("does not look inside a string, a comment or a dollar-quoted text: a word there is not a column", () => {
    expect(sensitiveNamesIn("SELECT 'the password was reset' AS note FROM t")).toEqual([]);
    expect(sensitiveNamesIn("SELECT 1 -- password\n, 2 /* token */")).toEqual([]);
    expect(sensitiveNamesIn("SELECT $q$ secret $q$ AS x")).toEqual([]);
    expect(sensitiveNamesIn("SELECT 'it''s a token' AS x, name FROM t")).toEqual([]);
  });

  it("finds nothing in an ordinary statement, and at most five names", () => {
    expect(
      sensitiveNamesIn("SELECT id, email, created_at FROM users ORDER BY id LIMIT 10"),
    ).toEqual([]);
    const many = `SELECT ${["password", "secret", "token", "passwd", "apikey", "credential", "passphrase"].join(", ")} FROM t`;
    expect(sensitiveNamesIn(many)).toHaveLength(5);
  });
});

describe("what the database's own sentence may say", () => {
  it("passes on the words of a syntax error or an unknown name, our own refusals and a time limit", () => {
    expect(
      failureWords({ code: "42703", message: 'column "emai" does not exist', position: 8 }),
    ).toBe('column "emai" does not exist');
    expect(
      failureWords({ code: "42601", message: 'syntax error at or near "FORM"', position: 3 }),
    ).toMatch(/syntax error/);
    expect(
      failureWords({
        code: "not_allowed",
        message: "Only SELECT ... can be run here.",
        position: null,
      }),
    ).toMatch(/Only SELECT/);
    expect(
      failureWords({
        code: "57014",
        message: "canceling statement due to statement timeout",
        position: null,
      }),
    ).toMatch(/timeout/);
  });

  it("does not pass on a message about a value: it could hold a value of the data", () => {
    for (const code of ["22P02", "22003", "22012", "23505", "XX000", "0A000"]) {
      const words = failureWords({
        code,
        message: 'invalid input syntax for type integer: "s3cret-value-of-a-row"',
        position: null,
      });
      expect(words, code).not.toContain("s3cret-value-of-a-row");
      expect(words).toContain(`SQLSTATE ${code}`);
    }
  });
});

describe("the result of a statement", () => {
  const result = (over: Partial<Parameters<typeof shapeQueryResult>[0]> = {}) => ({
    columns: [
      { name: "id", dataType: "integer" },
      { name: "password_hash", dataType: "text" },
      { name: "note", dataType: "text" },
    ],
    rows: [
      ["1", "hunter2-SECRET", "a"],
      ["2", "other-SECRET", null],
    ],
    truncated: false,
    command: "SELECT",
    cutCells: 0,
    elapsedMs: 1,
    ...over,
  });

  it("replaces the values of a hidden column with NULL and names it", () => {
    const shaped = shapeQueryResult(result());
    expect(shaped.rows).toEqual([
      ["1", null, "a"],
      ["2", null, null],
    ]);
    expect(shaped.hiddenColumns).toEqual(["password_hash"]);
    expect(shaped.columns[1]).toEqual({ name: "password_hash", type: "text", hidden: true });
    expect(JSON.stringify(shaped)).not.toContain("SECRET");
  });

  it("cuts a long cell at 500 characters and counts it", () => {
    const shaped = shapeQueryResult(
      result({ rows: [["1", "x", "y".repeat(CELL_CHARS + 50)]], cutCells: 1 }),
    );
    expect(shaped.rows[0]![2]).toHaveLength(CELL_CHARS);
    expect(shaped.cutCells).toBe(2);
  });

  it("keeps the rows that fit in about 100 KB and says the rest was left out", () => {
    const big = Array.from({ length: 400 }, (_, i) => [String(i), "x", "z".repeat(CELL_CHARS)]);
    const shaped = shapeQueryResult(result({ rows: big }));
    expect(shaped.truncated).toBe(true);
    expect(shaped.rows.length).toBeLessThan(400);
    expect(JSON.stringify(shaped.rows).length).toBeLessThanOrEqual(RESULT_CHARS + 600);
    // The database's own truncation is kept too.
    expect(shapeQueryResult(result({ truncated: true })).truncated).toBe(true);
  });
});

describe("a page of rows", () => {
  const page = (over: Partial<RowPage> = {}): RowPage =>
    ({
      columns: [
        { name: "id", dataType: "integer", masked: false, kind: "ordered" },
        { name: "api_token", dataType: "text", masked: true, kind: "text" },
      ],
      rows: [
        [
          { value: "1", truncated: false },
          { value: "tok-SECRET", truncated: false },
        ],
        [
          { value: "2", truncated: false },
          { value: null, truncated: false },
        ],
      ],
      nextCursor: "abc",
      order: { kind: "primary_key", columns: ["id"] },
      hiddenColumns: 0,
      cutBySize: false,
      offsetCapped: false,
      rowSecurity: "off",
      ...over,
    }) as RowPage;

  it("never carries a hidden column's value, names it, and passes the cursor on", () => {
    const shaped = shapePage(page());
    expect(shaped.rows).toEqual([
      ["1", null],
      ["2", null],
    ]);
    expect(shaped.nextCursor).toBe("abc");
    expect(shaped.hiddenColumns).toEqual(["api_token"]);
    expect(shaped.notes).toEqual(["Hidden columns, never returned: api_token."]);
    expect(JSON.stringify(shaped)).not.toContain("SECRET");
  });

  it("says what else is true of the page: columns not shown, row security, the size", () => {
    const shaped = shapePage(page({ hiddenColumns: 3, rowSecurity: "applies", cutBySize: true }));
    expect(shaped.notes.join(" ")).toMatch(/3 more columns/);
    expect(shaped.notes.join(" ")).toMatch(/Row-level security applies/);
    expect(shaped.notes.join(" ")).toMatch(/shortened to fit/);
  });
});
