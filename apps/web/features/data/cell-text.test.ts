import { describe, expect, it } from "vitest";
import { GRID_CELL_CHARS, describeCell, describeRowEstimate, hasMoreToShow } from "./cell-text";

const cell = (value: string | null, truncated = false) => ({ value, truncated });

describe("describeCell", () => {
  it("tells NULL, the empty string, a hidden column and a value apart", () => {
    expect(describeCell(cell(null), false)).toEqual({ kind: "null", text: "NULL" });
    expect(describeCell(cell(""), false)).toEqual({ kind: "empty", text: "(empty)" });
    expect(describeCell(cell("x"), true)).toEqual({ kind: "hidden", text: "hidden" });
    expect(describeCell(cell("x"), false)).toEqual({ kind: "value", text: "x", clipped: false });
  });

  it("never shows the value of a hidden column, whatever the cell holds", () => {
    expect(JSON.stringify(describeCell(cell("hunter2"), true))).not.toContain("hunter2");
  });

  it("a text that is literally NULL or (empty) is still a value, not those markers", () => {
    expect(describeCell(cell("NULL"), false)).toEqual({
      kind: "value",
      text: "NULL",
      clipped: false,
    });
    expect(describeCell(cell("(empty)"), false)).toMatchObject({ kind: "value" });
  });

  it("keeps a value that is only spaces visible as a value", () => {
    expect(describeCell(cell("   "), false)).toMatchObject({ kind: "value" });
  });

  it("shows a long value cut to the grid limit, marked as clipped", () => {
    const shown = describeCell(cell("a".repeat(GRID_CELL_CHARS + 50)), false);
    expect(shown).toMatchObject({ kind: "value", clipped: true });
    expect((shown as { text: string }).text).toHaveLength(GRID_CELL_CHARS);
    expect(describeCell(cell("b".repeat(GRID_CELL_CHARS)), false)).toMatchObject({
      clipped: false,
    });
  });

  it("marks a value the server cut as clipped even when it is short", () => {
    expect(describeCell(cell("short", true), false)).toMatchObject({ clipped: true });
  });

  it("does not split an emoji at the grid limit", () => {
    const text = `${"a".repeat(GRID_CELL_CHARS - 1)}🙂tail`;
    const shown = describeCell(cell(text), false) as { text: string };
    expect(/[\ud800-\udbff]$/.test(shown.text)).toBe(false);
  });

  it("puts a multi-line value on one line for the grid", () => {
    expect(describeCell(cell("line one\n  line two\tthree"), false)).toMatchObject({
      text: "line one line two three",
    });
  });
});

describe("hasMoreToShow", () => {
  it("is true only when the dialog would add something", () => {
    expect(hasMoreToShow(cell("short"), false)).toBe(false);
    expect(hasMoreToShow(cell("a".repeat(GRID_CELL_CHARS + 1)), false)).toBe(true);
    expect(hasMoreToShow(cell("cut", true), false)).toBe(true);
    expect(hasMoreToShow(cell("a\nb"), false)).toBe(true);
    expect(hasMoreToShow(cell(null), false)).toBe(false);
    expect(hasMoreToShow(cell(""), false)).toBe(false);
    expect(hasMoreToShow(cell("x".repeat(500)), true)).toBe(false);
  });
});

describe("describeRowEstimate", () => {
  it("says about how many rows, never an exact count", () => {
    expect(describeRowEstimate(null)).toBeNull();
    expect(describeRowEstimate(0)).toBe("about 0 rows");
    expect(describeRowEstimate(120)).toBe("about 120 rows");
    expect(describeRowEstimate(1_200_000)).toBe("about 1.2M rows");
    expect(describeRowEstimate(52_000)).toBe("about 52K rows");
  });
});
