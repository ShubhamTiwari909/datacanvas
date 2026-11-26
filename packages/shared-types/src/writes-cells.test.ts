/**
 * The contract of `edit_cells` (section 5 of `docs/write-side-v2-plan.md`): strict at every level, at most 500 rows
 * of at most 50 cells, every row named once by its whole key, every cell with the value that was seen, each column
 * at most once in a row. A request cannot hold SQL.
 */
import { EDIT_CELLS_MAX_CELLS_PER_ROW, MAX_BULK_ROWS } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  WRITE_MAX_BULK_ROWS,
  WRITE_MAX_CHANGE_VALUE_CHARS,
  WRITE_MAX_EDIT_CELLS_PER_ROW,
  changeSchema,
  previewChangeRequestSchema,
} from "./writes.js";

const table = { schema: "public", name: "items" };
const row = (id: number, column = "status", value: string | null = "done") => ({
  key: [{ column: "id", value: String(id) }],
  changes: [{ column, value, expected: "new" }],
});
const edit = (over: Record<string, unknown> = {}) => ({
  kind: "edit_cells",
  table,
  revealColumns: [],
  rows: [row(1), row(2, "note", null)],
  ...over,
});
const issues = (value: unknown): string[] => {
  const result = changeSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("edit_cells", () => {
  it("mirrors the core's limits", () => {
    expect(WRITE_MAX_EDIT_CELLS_PER_ROW).toBe(EDIT_CELLS_MAX_CELLS_PER_ROW);
    expect(WRITE_MAX_EDIT_CELLS_PER_ROW).toBe(50);
    expect(WRITE_MAX_BULK_ROWS).toBe(MAX_BULK_ROWS);
  });

  it("accepts a well-formed change: different columns in different rows, NULL as a value and as what was seen", () => {
    expect(changeSchema.safeParse(edit()).success).toBe(true);
    const nulls = edit({
      rows: [
        {
          key: [{ column: "id", value: "1" }],
          changes: [
            { column: "a", value: null, expected: null },
            { column: "b", value: "", expected: "" },
          ],
        },
      ],
      revealColumns: ["api_token"],
    });
    expect(changeSchema.parse(nulls)).toEqual(nulls);
    expect(previewChangeRequestSchema.safeParse({ change: edit() }).success).toBe(true);
    // Two rows may set the same column to different values.
    expect(
      changeSchema.safeParse(edit({ rows: [row(1), row(2, "status", "other")] })).success,
    ).toBe(true);
  });

  it.each([
    ["no rows", { rows: [] }],
    ["a row without a change", { rows: [{ key: row(1).key, changes: [] }] }],
    ["a row without a key", { rows: [{ key: [], changes: row(1).changes }] }],
    ["no revealColumns", { revealColumns: undefined }],
    [
      "a cell without the value that was seen",
      { rows: [{ key: row(1).key, changes: [{ column: "status", value: "x" }] }] },
    ],
    [
      "a value that is not text or null",
      { rows: [{ key: row(1).key, changes: [{ column: "status", value: 5, expected: "x" }] }] },
    ],
    [
      "a key value that is null",
      { rows: [{ key: [{ column: "id", value: null }], changes: row(1).changes }] },
    ],
    [
      "a value over the limit",
      {
        rows: [
          {
            key: row(1).key,
            changes: [
              { column: "s", value: "x".repeat(WRITE_MAX_CHANGE_VALUE_CHARS + 1), expected: null },
            ],
          },
        ],
      },
    ],
    [
      "a value seen over the limit",
      {
        rows: [
          {
            key: row(1).key,
            changes: [
              { column: "s", value: null, expected: "x".repeat(WRITE_MAX_CHANGE_VALUE_CHARS + 1) },
            ],
          },
        ],
      },
    ],
    [
      "a lone half of a surrogate pair",
      { rows: [{ key: row(1).key, changes: [{ column: "s", value: "a\ud800", expected: null }] }] },
    ],
    ["an empty column name", { rows: [row(1, "")] }],
  ])("refuses %s", (_name, over) => {
    expect(changeSchema.safeParse(edit(over)).success).toBe(false);
  });

  it("refuses a row named twice, also with its key columns in another order, and keeps different rows apart", () => {
    expect(issues(edit({ rows: [row(1), row(1, "note")] }))).toEqual(["A row is listed twice."]);
    const composite = (a: string, b: string, swap = false) => {
      const parts = [
        { column: "a", value: a },
        { column: "b", value: b },
      ];
      return { key: swap ? parts.reverse() : parts, changes: row(1).changes };
    };
    expect(issues(edit({ rows: [composite("1", "2"), composite("1", "2", true)] }))).toEqual([
      "A row is listed twice.",
    ]);
    expect(
      changeSchema.safeParse(edit({ rows: [composite("1", "2"), composite("2", "1")] })).success,
    ).toBe(true);
  });

  it("refuses a column changed twice in one row, and a key column listed twice", () => {
    const twice = {
      key: row(1).key,
      changes: [
        { column: "status", value: "a", expected: "new" },
        { column: "status", value: "b", expected: "new" },
      ],
    };
    expect(issues(edit({ rows: [twice] }))).toEqual(["A column is changed twice in one row."]);
    const doubleKey = {
      key: [
        { column: "id", value: "1" },
        { column: "id", value: "1" },
      ],
      changes: row(1).changes,
    };
    expect(issues(edit({ rows: [doubleKey] }))).toEqual(["A key column is listed twice."]);
  });

  it(`takes at most ${WRITE_MAX_BULK_ROWS} rows and ${WRITE_MAX_EDIT_CELLS_PER_ROW} cells in a row`, () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));
    expect(changeSchema.safeParse(edit({ rows: rows(WRITE_MAX_BULK_ROWS) })).success).toBe(true);
    expect(changeSchema.safeParse(edit({ rows: rows(WRITE_MAX_BULK_ROWS + 1) })).success).toBe(
      false,
    );
    const cells = (n: number) => ({
      key: row(1).key,
      changes: Array.from({ length: n }, (_, i) => ({
        column: `c${i}`,
        value: "v",
        expected: null,
      })),
    });
    expect(
      changeSchema.safeParse(edit({ rows: [cells(WRITE_MAX_EDIT_CELLS_PER_ROW)] })).success,
    ).toBe(true);
    expect(
      changeSchema.safeParse(edit({ rows: [cells(WRITE_MAX_EDIT_CELLS_PER_ROW + 1)] })).success,
    ).toBe(false);
    expect(
      changeSchema.safeParse(edit({ revealColumns: rows(101).map((_, i) => `c${i}`) })).success,
    ).toBe(false);
  });

  it.each(["sql", "where", "expression", "using", "returning", "set", "filters", "limit", "all"])(
    "refuses a %s anywhere in the request",
    (name) => {
      expect(changeSchema.safeParse(edit({ [name]: "1=1" })).success).toBe(false);
      expect(changeSchema.safeParse(edit({ table: { ...table, [name]: "x" } })).success).toBe(
        false,
      );
      expect(changeSchema.safeParse(edit({ rows: [{ ...row(1), [name]: "x" }] })).success).toBe(
        false,
      );
      expect(
        changeSchema.safeParse(
          edit({
            rows: [
              {
                key: row(1).key,
                changes: [{ column: "status", value: "x", expected: "y", [name]: "z" }],
              },
            ],
          }),
        ).success,
      ).toBe(false);
      expect(
        changeSchema.safeParse(
          edit({
            rows: [{ key: [{ column: "id", value: "1", [name]: "z" }], changes: row(1).changes }],
          }),
        ).success,
      ).toBe(false);
    },
  );
});
