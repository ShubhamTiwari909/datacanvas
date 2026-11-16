/** The statement for a filtered page, as text: each operator, how conditions combine with paging and sorting. */
import { ROWS_CELL_CHARS, ROW_FILTER_OPS, type RowFilterOp } from "@datacanvas/database-core";
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

const CUT = ROWS_CELL_CHARS + 1;
const PREFIX =
  'SELECT 1 AS r, left(CAST("id" AS text), $1) AS c0, left(CAST("email" AS text), $1) AS c1, CAST("id" AS text) AS k0 FROM "public"."users"';

describe("buildRowsQuery with conditions", () => {
  it.each([
    ["eq", '"email" = $2'],
    ["neq", '"email" IS DISTINCT FROM $2'],
    ["gt", '"email" > $2'],
    ["gte", '"email" >= $2'],
    ["lt", '"email" < $2'],
    ["lte", '"email" <= $2'],
    ["contains", 'strpos(lower(CAST("email" AS text)), lower($2)) > 0'],
    ["starts_with", 'starts_with(lower(CAST("email" AS text)), lower($2))'],
  ] as const)("writes %s with the value as a bound parameter", (op, condition) => {
    expect(buildRowsQuery(plan({ filters: [{ column: "email", op, value: "bob" }] }))).toEqual({
      text: `${PREFIX} WHERE ${condition} ORDER BY "id" LIMIT $3`,
      values: [CUT, "bob", 51],
    });
  });

  it.each([
    ["is_null", '"email" IS NULL'],
    ["is_not_null", '"email" IS NOT NULL'],
  ] as const)("writes %s with no parameter at all", (op, condition) => {
    expect(buildRowsQuery(plan({ filters: [{ column: "email", op }] }))).toEqual({
      text: `${PREFIX} WHERE ${condition} ORDER BY "id" LIMIT $2`,
      values: [CUT, 51],
    });
  });

  it("covers every operator there is", () => {
    for (const op of ROW_FILTER_OPS) {
      const nullary = op === "is_null" || op === "is_not_null";
      const { text } = buildRowsQuery(
        plan({
          filters: [nullary ? { column: "email", op } : { column: "email", op, value: "v" }],
        }),
      );
      expect(text, op).toContain("WHERE");
    }
  });

  it("joins several conditions with AND, in the order given, numbering the parameters in that order", () => {
    const { text, values } = buildRowsQuery(
      plan({
        filters: [
          { column: "id", op: "gte", value: "3" },
          { column: "email", op: "contains", value: "x" },
          { column: "id", op: "is_not_null" },
          { column: "id", op: "lt", value: "9" },
        ],
      }),
    );
    expect(text).toContain(
      'WHERE "id" >= $2 AND strpos(lower(CAST("email" AS text)), lower($3)) > 0 AND "id" IS NOT NULL AND "id" < $4 ORDER BY',
    );
    expect(values).toEqual([CUT, "3", "x", "9", 51]);
  });

  it("puts the person's conditions before the paging position, which is required as well", () => {
    const { text, values } = buildRowsQuery(
      plan({ filters: [{ column: "email", op: "eq", value: "v" }], after: ["7"], limit: 5 }),
    );
    expect(text).toContain('WHERE "email" = $2 AND ROW("id") > ROW($3) ORDER BY "id" LIMIT $4');
    expect(values).toEqual([CUT, "v", "7", 5]);
  });

  it("keeps them apart from the paging position of a sorted page", () => {
    const { text } = buildRowsQuery(
      plan({
        filters: [{ column: "email", op: "neq", value: "v" }],
        sort: { column: "email", direction: "asc" },
        after: ["7"],
        afterSort: { value: "bob" },
      }),
    );
    expect(text).toContain(
      'WHERE "email" IS DISTINCT FROM $3 AND ("email" > $5 OR ("email" = $5 AND ROW("id") > ROW($4)) OR "email" IS NULL) ORDER BY "email" ASC NULLS LAST, "id"',
    );
  });

  it("filters a table without a key too, which is paged by position", () => {
    const { text, values } = buildRowsQuery(
      plan({
        keyColumns: [],
        filters: [{ column: "email", op: "starts_with", value: "a" }],
        offset: 20,
        limit: 11,
      }),
    );
    expect(text).toBe(
      'SELECT 1 AS r, left(CAST("id" AS text), $1) AS c0, left(CAST("email" AS text), $1) AS c1 FROM "public"."users" ' +
        'WHERE starts_with(lower(CAST("email" AS text)), lower($2)) LIMIT $3 OFFSET $4',
    );
    expect(values).toEqual([CUT, "a", 11, 20]);
  });

  it("can filter on a column that is not shown, such as a hidden one that was revealed away from the list", () => {
    const { text } = buildRowsQuery(
      plan({ shown: [{ position: 0, name: "id" }], filters: [{ column: "email", op: "is_null" }] }),
    );
    expect(text).toContain('WHERE "email" IS NULL');
  });

  it("builds the same statement as before when there are no conditions", () => {
    expect(buildRowsQuery(plan({ filters: [] })).text).toBe(buildRowsQuery(plan()).text);
    expect(buildRowsQuery(plan()).text).not.toContain("WHERE");
  });

  it("writes no wildcard: a % _ or backslash in a value is a character, and only a parameter", () => {
    const value = "50%_off\\ 'quoted' \"x\"; DROP TABLE users; --";
    const { text, values } = buildRowsQuery(
      plan({ filters: [{ column: "email", op: "contains", value }] }),
    );
    expect(text).not.toMatch(/LIKE/i);
    expect(text).not.toContain("%");
    expect(text).not.toContain("DROP");
    expect(text).not.toContain("quoted");
    expect(values).toContain(value);
  });

  it("quotes the column of a condition like any other name", () => {
    const { text } = buildRowsQuery(
      plan({ filters: [{ column: 'we"ird; --', op: "eq", value: "v" }] }),
    );
    expect(text).toContain('WHERE "we""ird; --" = $2');
  });

  it("refuses an operator it does not know, and a missing value, rather than guessing", () => {
    const bad = (filter: unknown) => () =>
      buildRowsQuery(plan({ filters: [filter as { column: string; op: RowFilterOp }] }));
    expect(bad({ column: "email", op: "like", value: "x" })).toThrow();
    expect(bad({ column: "email", op: "toString", value: "x" })).toThrow();
    expect(bad({ column: "email", op: "eq" })).toThrow();
  });
});
