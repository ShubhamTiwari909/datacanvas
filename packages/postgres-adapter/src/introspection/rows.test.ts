import { ROWS_CELL_CHARS } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { buildRowsQuery, type RowsQueryPlan } from "./rows.js";

const plan = (overrides: Partial<RowsQueryPlan> = {}): RowsQueryPlan => ({
  schema: "public",
  table: "users",
  shown: [
    { position: 0, name: "id" },
    { position: 1, name: "email" },
  ],
  keyColumns: ["id"],
  after: null,
  offset: 0,
  limit: 51,
  ...overrides,
});

describe("buildRowsQuery", () => {
  it("builds the first page of a table with a key", () => {
    expect(buildRowsQuery(plan())).toEqual({
      text:
        'SELECT 1 AS r, left(CAST("id" AS text), $1) AS c0, left(CAST("email" AS text), $1) AS c1, CAST("id" AS text) AS k0 ' +
        'FROM "public"."users" ORDER BY "public"."users"."id" LIMIT $2',
      values: [ROWS_CELL_CHARS + 1, 51],
    });
  });

  it("continues after a key with a row comparison, every value a bound parameter", () => {
    const { text, values } = buildRowsQuery(
      plan({ keyColumns: ["a", "b"], after: ["7", "x"], limit: 3 }),
    );
    expect(text).toContain(
      'WHERE ROW("a", "b") > ROW($2, $3) ORDER BY "public"."users"."a", "public"."users"."b" LIMIT $4',
    );
    expect(values).toEqual([ROWS_CELL_CHARS + 1, "7", "x", 3]);
  });

  it("reads a table without a key by position, with no order promised", () => {
    const { text, values } = buildRowsQuery(plan({ keyColumns: [], offset: 100, limit: 11 }));
    expect(text).toBe(
      'SELECT 1 AS r, left(CAST("id" AS text), $1) AS c0, left(CAST("email" AS text), $1) AS c1 ' +
        'FROM "public"."users" LIMIT $2 OFFSET $3',
    );
    expect(text).not.toMatch(/ORDER BY|WHERE/);
    expect(values).toEqual([ROWS_CELL_CHARS + 1, 11, 100]);
  });

  it("selects the key a second time without cutting it, so the cursor is the real key", () => {
    const { text } = buildRowsQuery(plan({ shown: [{ position: 0, name: "id" }] }));
    expect(text).toContain('left(CAST("id" AS text), $1) AS c0');
    expect(text).toContain('CAST("id" AS text) AS k0');
    expect(text).not.toContain('left(CAST("id" AS text), $1) AS k0');
  });

  it("still has a select list, and no unused parameter, when every column is masked", () => {
    // PostgreSQL refuses a statement with a parameter nothing refers to, so the cell
    // limit is not passed when no column uses it.
    const { text, values } = buildRowsQuery(
      plan({ shown: [], keyColumns: [], offset: 5, limit: 4 }),
    );
    expect(text).toBe('SELECT 1 AS r FROM "public"."users" LIMIT $1 OFFSET $2');
    expect(values).toEqual([4, 5]);
  });

  it("quotes awkward names and keeps them out of the aliases", () => {
    const { text } = buildRowsQuery(
      plan({
        schema: 'we"ird schema',
        table: "tab;le --",
        shown: [
          { position: 0, name: 'sel"ect' },
          { position: 5, name: "日本語 🙂" },
        ],
        keyColumns: ['k"1'],
      }),
    );
    expect(text).toContain('FROM "we""ird schema"."tab;le --"');
    expect(text).toContain('left(CAST("sel""ect" AS text), $1) AS c0');
    expect(text).toContain('left(CAST("日本語 🙂" AS text), $1) AS c5');
    expect(text).toContain('CAST("k""1" AS text) AS k0');
    // Aliases are positions, never names.
    expect(text).not.toMatch(/AS "/);
  });

  it("never puts a value in the statement text: a forged key is only a parameter", () => {
    const hostile = "1'; DROP TABLE users; --";
    const { text, values } = buildRowsQuery(plan({ after: [hostile] }));
    expect(text).not.toContain("DROP");
    expect(text).not.toContain("1'");
    expect(values).toContain(hostile);
  });
});
