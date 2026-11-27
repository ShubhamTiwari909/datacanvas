/**
 * The contracts of a change of the rows a filter matches (`update_matching`, `delete_matching`;
 * `docs/write-side-v2-plan.md`, section 6): strict at every level, the page reader's own conditions (at least one,
 * at most ten), one column and value for an update, nothing for a delete. The apply request carries the count the
 * person typed, a bounded whole number; the preview answers the count found. A request cannot hold SQL.
 */
import { MATCHING_MAX_ROWS } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { MAX_ROW_FILTERS } from "./row-filters.js";
import {
  WRITE_MAX_MATCHING_ROWS,
  applyChangeRequestSchema,
  changePreviewSchema,
  changeSchema,
  previewChangeRequestSchema,
} from "./writes.js";

const table = { schema: "public", name: "items" };
const filter = { column: "note", op: "contains", value: "x" };
const updateMatching = (over: Record<string, unknown> = {}) => ({
  kind: "update_matching",
  table,
  filters: [filter],
  revealColumns: [],
  set: { column: "name", value: "y" },
  ...over,
});
const deleteMatching = (over: Record<string, unknown> = {}) => ({
  kind: "delete_matching",
  table,
  filters: [filter],
  revealColumns: [],
  ...over,
});

describe("update_matching and delete_matching", () => {
  it("accept the page reader's conditions: several, grouped, every shape, and NULL as the value", () => {
    const filters = [
      { column: "qty", op: "between", values: ["1", "5"] },
      { column: "note", op: "is_null" },
      { column: "doc", op: "json_path_eq", path: ["a", "b"], value: "1", group: 1 },
      { column: "tags", op: "array_contains", values: ["x"], group: 1 },
    ];
    expect(changeSchema.safeParse(updateMatching({ filters })).success).toBe(true);
    expect(
      changeSchema.safeParse(updateMatching({ set: { column: "name", value: null } })).success,
    ).toBe(true);
    expect(changeSchema.safeParse(deleteMatching({ revealColumns: ["api_token"] })).success).toBe(
      true,
    );
    expect(previewChangeRequestSchema.safeParse({ change: deleteMatching() }).success).toBe(true);
  });

  it.each([
    ["an empty filter", { filters: [] }],
    ["too many conditions", { filters: Array.from({ length: MAX_ROW_FILTERS + 1 }, () => filter) }],
    ["a condition of the wrong shape", { filters: [{ column: "note", op: "eq" }] }],
    ["an operator that is not on the list", { filters: [{ ...filter, op: "like" }] }],
    ["a condition with SQL in it", { filters: [{ ...filter, sql: "1=1" }] }],
    [
      "too many revealed columns",
      { revealColumns: Array.from({ length: 101 }, (_, i) => `c${i}`) },
    ],
    ["no revealed columns at all", { revealColumns: undefined }],
  ])("refuses %s", (_, over) => {
    expect(changeSchema.safeParse(updateMatching(over)).success).toBe(false);
    expect(changeSchema.safeParse(deleteMatching(over)).success).toBe(false);
  });

  it("refuses an update without one column and one value, and a delete with one", () => {
    expect(changeSchema.safeParse(updateMatching({ set: undefined })).success).toBe(false);
    expect(
      changeSchema.safeParse(updateMatching({ set: [{ column: "name", value: "y" }] })).success,
    ).toBe(false);
    expect(
      changeSchema.safeParse(updateMatching({ set: { column: "name", value: "\uD800" } })).success,
    ).toBe(false);
    expect(
      changeSchema.safeParse(deleteMatching({ set: { column: "name", value: "y" } })).success,
    ).toBe(false);
  });

  it.each(["sql", "where", "expression", "using", "returning", "query", "keys"])(
    "refuses a %s key at every level",
    (key) => {
      expect(changeSchema.safeParse(updateMatching({ [key]: "x" })).success).toBe(false);
      expect(changeSchema.safeParse(deleteMatching({ [key]: "x" })).success).toBe(false);
      expect(
        changeSchema.safeParse(updateMatching({ table: { ...table, [key]: "x" } })).success,
      ).toBe(false);
      expect(
        changeSchema.safeParse(updateMatching({ set: { column: "name", value: "y", [key]: "x" } }))
          .success,
      ).toBe(false);
      expect(
        changeSchema.safeParse(deleteMatching({ filters: [{ ...filter, [key]: "x" }] })).success,
      ).toBe(false);
    },
  );
});

describe("the typed count", () => {
  it("mirrors the core's limit", () => {
    expect(WRITE_MAX_MATCHING_ROWS).toBe(MATCHING_MAX_ROWS);
  });

  it("is optional on apply, and a whole number from 0 to the limit when given", () => {
    const previewId = "a".repeat(22);
    expect(applyChangeRequestSchema.safeParse({ previewId }).success).toBe(true);
    for (const confirmRows of [0, 1, WRITE_MAX_MATCHING_ROWS]) {
      expect(applyChangeRequestSchema.parse({ previewId, confirmRows }).confirmRows).toBe(
        confirmRows,
      );
    }
    for (const confirmRows of [-1, 1.5, "3", null, WRITE_MAX_MATCHING_ROWS + 1]) {
      expect(applyChangeRequestSchema.safeParse({ previewId, confirmRows }).success).toBe(false);
    }
    expect(applyChangeRequestSchema.safeParse({ previewId, confirmRows: 3, rows: 3 }).success).toBe(
      false,
    );
  });

  it("is answered with the preview of such a change, and null for any other", () => {
    const base = {
      previewId: "a".repeat(22),
      statement: "x",
      effect: "y",
      warnings: [],
      destructive: true,
      category: "row",
      expiresAt: new Date(0).toISOString(),
    };
    expect(changePreviewSchema.parse(base).confirmRows).toBeNull();
    expect(changePreviewSchema.parse({ ...base, confirmRows: 1200 }).confirmRows).toBe(1200);
  });
});
