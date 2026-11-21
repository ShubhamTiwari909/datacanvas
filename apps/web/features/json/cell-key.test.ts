import type { RowCell, RowColumn, RowPage } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { wholeCellKey } from "./cell-key";

const col = (name: string, masked = false): RowColumn => ({
  name,
  dataType: "text",
  masked,
  kind: "text",
});
const cell = (value: string | null, truncated = false): RowCell => ({ value, truncated });
const page = (over: Partial<RowPage>): RowPage =>
  ({
    columns: [col("a"), col("doc"), col("b")],
    rows: [[cell("1"), cell("{}"), cell("x")]],
    order: { kind: "primary_key", columns: ["a"] },
    ...over,
  }) as RowPage;

describe("wholeCellKey", () => {
  it("is the row's key columns, as read", () => {
    expect(wholeCellKey(page({}), 0)).toEqual([{ column: "a", value: "1" }]);
    expect(wholeCellKey(page({ order: { kind: "unique_index", columns: ["b", "a"] } }), 0)).toEqual(
      [
        { column: "b", value: "x" },
        { column: "a", value: "1" },
      ],
    );
  });

  it("is null for a table without a key, a row that is not there, or a key column that is missing", () => {
    expect(wholeCellKey(page({ order: { kind: "none", columns: [] } }), 0)).toBeNull();
    expect(wholeCellKey(page({}), 5)).toBeNull();
    expect(wholeCellKey(page({ order: { kind: "primary_key", columns: ["nope"] } }), 0)).toBeNull();
  });

  it("is null when a key value was cut, hidden or NULL: the row cannot be named from it", () => {
    expect(wholeCellKey(page({ rows: [[cell("1", true), cell("{}"), cell("x")]] }), 0)).toBeNull();
    expect(wholeCellKey(page({ columns: [col("a", true), col("doc"), col("b")] }), 0)).toBeNull();
    expect(wholeCellKey(page({ rows: [[cell(null), cell("{}"), cell("x")]] }), 0)).toBeNull();
  });
});
