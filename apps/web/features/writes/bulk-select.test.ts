import {
  MAX_BULK_ROWS,
  type RowCell,
  type RowColumn,
  type TableEditInfo,
} from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  BULK_PREVIEW_ROWS,
  EMPTY_SELECTION,
  buildDeleteRows,
  buildUpdateRows,
  bulkDeleteBeforeAfter,
  bulkUpdateBeforeAfter,
  pageSelectable,
  pageState,
  rowSignature,
  selectedRowAt,
  toggleRow,
  togglePage,
} from "./bulk-select";

const table = { schema: "public", name: "items" };
const columns: RowColumn[] = [
  { name: "id", dataType: "integer", masked: false, kind: "ordered" },
  { name: "status", dataType: "text", masked: false, kind: "text" },
  { name: "api_key", dataType: "text", masked: true, kind: "text" },
];
const cell = (value: string | null, truncated = false): RowCell => ({ value, truncated });
const row = (id: number, status = "new", truncated = false): RowCell[] => [
  cell(String(id)),
  cell(status, truncated),
  cell(null),
];
const info: Pick<TableEditInfo, "editable" | "key" | "reason"> = {
  editable: true,
  key: ["id"],
  reason: null,
};
const page = (n: number, from = 1) => ({
  columns,
  rows: Array.from({ length: n }, (_, i) => row(from + i)),
});

describe("selectedRowAt", () => {
  it("keeps the key and the cells as seen, and leaves a hidden column out", () => {
    const chosen = selectedRowAt(columns, row(7, "old"), info)!;
    expect(chosen.key).toEqual([{ column: "id", value: "7" }]);
    expect(chosen.cells).toEqual({
      id: { value: "7", truncated: false },
      status: { value: "old", truncated: false },
    });
    expect(chosen.cells).not.toHaveProperty("api_key");
  });

  it("is null for a row that cannot be found by its key", () => {
    expect(
      selectedRowAt(columns, row(7), { ...info, editable: false, reason: "no_key" }),
    ).toBeNull();
    expect(selectedRowAt(columns, [cell(null), cell("x"), cell(null)], info)).toBeNull();
    expect(selectedRowAt(columns, [cell("7", true), cell("x"), cell(null)], info)).toBeNull();
  });
});

describe("toggling rows", () => {
  const selectable = pageSelectable(page(10), info);

  it("chooses a row, lets go of it, and remembers it by key", () => {
    const one = toggleRow(EMPTY_SELECTION, selectable, 2, false, null);
    expect([...one.selection.keys()]).toEqual([rowSignature([{ column: "id", value: "3" }])]);
    expect(one.anchor).toBe(2);
    const none = toggleRow(one.selection, selectable, 2, false, one.anchor);
    expect(none.selection.size).toBe(0);
  });

  it("extends a range from the last row clicked, in either direction, the way the clicked row goes", () => {
    const first = toggleRow(EMPTY_SELECTION, selectable, 2, false, null);
    const range = toggleRow(first.selection, selectable, 5, true, first.anchor);
    expect([...range.selection.values()].map((r) => r.key[0]!.value)).toEqual(["3", "4", "5", "6"]);
    const back = toggleRow(range.selection, selectable, 1, true, range.anchor);
    // From the row last clicked (6) back to the second row: rows 2 to 6.
    expect(back.selection.size).toBe(5);
    // Clicking a chosen row with shift lets go of the whole range.
    const off = toggleRow(back.selection, selectable, 3, true, back.anchor);
    expect(off.selection.size).toBe(2);
  });

  it("ignores a row that cannot be chosen", () => {
    const blocked = [null, ...selectable.slice(1)];
    const result = toggleRow(EMPTY_SELECTION, blocked, 0, false, null);
    expect(result.selection.size).toBe(0);
    const range = toggleRow(EMPTY_SELECTION, blocked, 3, false, null);
    expect(toggleRow(range.selection, blocked, 0, true, range.anchor).selection.size).toBe(1);
  });

  it("skips a row that cannot be chosen in the middle of a range, and says when the most is reached", () => {
    const holes = [...selectable];
    holes[3] = null;
    const first = toggleRow(EMPTY_SELECTION, holes, 1, false, null);
    const range = toggleRow(first.selection, holes, 5, true, first.anchor);
    expect([...range.selection.values()].map((r) => r.key[0]!.value)).toEqual(["2", "3", "5", "6"]);
    expect(range.limited).toBe(false);
    // A range that does not fit in the most rows takes what fits and says so.
    const long = pageSelectable(page(MAX_BULK_ROWS + 20), info);
    const first500 = toggleRow(EMPTY_SELECTION, long, 0, false, null);
    const wide = toggleRow(first500.selection, long, MAX_BULK_ROWS + 10, true, first500.anchor);
    expect(wide.selection.size).toBe(MAX_BULK_ROWS);
    expect(wide.limited).toBe(true);
  });

  it("keeps the choice when the page changes, and counts a row once wherever it is shown", () => {
    const firstPage = pageSelectable(page(5, 1), info);
    const chosen = togglePage(EMPTY_SELECTION, firstPage);
    expect(chosen.selection.size).toBe(5);
    const secondPage = pageSelectable(page(5, 4), info); // rows 4 to 8: 4 and 5 are shown again
    const both = togglePage(chosen.selection, secondPage);
    expect(both.selection.size).toBe(8);
    expect(pageState(both.selection, firstPage)).toBe("all");
  });

  it("states what the page holds: none, some or all", () => {
    expect(pageState(EMPTY_SELECTION, selectable)).toBe("none");
    const some = toggleRow(EMPTY_SELECTION, selectable, 1, false, null).selection;
    expect(pageState(some, selectable)).toBe("some");
    expect(pageState(togglePage(some, selectable).selection, selectable)).toBe("all");
    expect(pageState(EMPTY_SELECTION, [null, null])).toBe("none");
  });

  it("lets go of the whole page when all of it is chosen", () => {
    const all = togglePage(EMPTY_SELECTION, selectable);
    expect(all.selection.size).toBe(10);
    expect(togglePage(all.selection, selectable).selection.size).toBe(0);
  });

  it(`never holds more than ${MAX_BULK_ROWS} rows, and says when it stopped`, () => {
    const big = pageSelectable(page(MAX_BULK_ROWS + 20), info);
    const result = togglePage(EMPTY_SELECTION, big);
    expect(result.selection.size).toBe(MAX_BULK_ROWS);
    expect(result.limited).toBe(true);
    const more = toggleRow(result.selection, big, MAX_BULK_ROWS + 5, false, null);
    expect(more.selection.size).toBe(MAX_BULK_ROWS);
    expect(more.limited).toBe(true);
    // Letting go of one makes room for another.
    const room = toggleRow(more.selection, big, 0, false, null);
    expect(toggleRow(room.selection, big, MAX_BULK_ROWS + 5, false, null).selection.size).toBe(
      MAX_BULK_ROWS,
    );
  });
});

describe("building the changes", () => {
  const rows = pageSelectable(page(4), info).filter((r): r is NonNullable<typeof r> => r !== null);

  it("sets one value on the chosen rows, each with what it was seen holding", () => {
    const built = buildUpdateRows(table, rows, "status", "done")!;
    expect(built.leftOut).toBe(0);
    expect(built.change).toEqual({
      kind: "update_rows",
      table,
      set: [{ column: "status", value: "done" }],
      rows: rows.map((r) => ({
        key: [{ column: "id", value: r.key[0]!.value }],
        expected: [{ column: "status", value: "new" }],
      })),
    });
    expect(buildUpdateRows(table, rows, "status", null)!.change.set).toEqual([
      { column: "status", value: null },
    ]);
  });

  it("leaves out a row whose value was cut (it cannot be compared), and says how many", () => {
    const withCut = [...rows, selectedRowAt(columns, row(9, "x", true), info)!];
    const built = buildUpdateRows(table, withCut, "status", "done")!;
    expect(built.leftOut).toBe(1);
    expect(built.change.rows).toHaveLength(4);
    expect(buildUpdateRows(table, [withCut[4]!], "status", "done")).toBeNull();
    // A column that was not read for the rows has nothing to compare with either.
    expect(buildUpdateRows(table, rows, "api_key", "x")).toBeNull();
  });

  it("builds a delete by key alone", () => {
    expect(buildDeleteRows(table, rows).rows).toEqual(
      rows.map((r) => ({ key: [{ column: "id", value: r.key[0]!.value }] })),
    );
  });

  it("shows the first rows before and after, labelled by their key, and no more than the limit", () => {
    const many = pageSelectable(page(BULK_PREVIEW_ROWS + 5), info).filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );
    const shown = bulkUpdateBeforeAfter(many, "status", "done");
    expect(shown).toHaveLength(BULK_PREVIEW_ROWS);
    expect(shown[0]).toEqual({
      column: "id 1",
      before: { kind: "value", text: "new", cut: false },
      after: { kind: "value", text: "done", cut: false },
    });
    expect(bulkUpdateBeforeAfter(many, "status", null)[0]!.after).toEqual({ kind: "null" });
    const gone = bulkDeleteBeforeAfter(many);
    expect(gone).toHaveLength(BULK_PREVIEW_ROWS);
    expect(gone[0]).toEqual({
      column: "id 1",
      before: { kind: "none" },
      after: { kind: "deleted" },
    });
  });
});
