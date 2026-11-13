import { describe, expect, it } from "vitest";
import {
  COLLAPSED_COLUMN_LIMIT,
  NODE_FOOTER_HEIGHT,
  NODE_HEADER_HEIGHT,
  NODE_ROW_HEIGHT,
} from "./constants.js";
import { estimateNodeHeight, hiddenColumnCount, visibleColumns } from "./columns.js";

const names = (n: number) => Array.from({ length: n }, (_v, i) => `c${i}`);

describe("visibleColumns", () => {
  it("shows everything when the table fits", () => {
    expect(visibleColumns(names(5), false)).toEqual(names(5));
  });

  it("shows only the first few columns of a wide collapsed table", () => {
    expect(visibleColumns(names(30), false)).toEqual(names(COLLAPSED_COLUMN_LIMIT));
  });

  it("shows everything when expanded, and returns a copy", () => {
    const all = names(30);
    const shown = visibleColumns(all, true);
    expect(shown).toEqual(all);
    expect(shown).not.toBe(all);
  });
});

describe("hiddenColumnCount", () => {
  it("counts what a collapsed table hides", () => {
    expect(hiddenColumnCount(30, false)).toBe(30 - COLLAPSED_COLUMN_LIMIT);
    expect(hiddenColumnCount(5, false)).toBe(0);
    expect(hiddenColumnCount(30, true)).toBe(0);
  });
});

describe("estimateNodeHeight", () => {
  it("is header plus rows for a small table", () => {
    expect(estimateNodeHeight(4, false)).toBe(NODE_HEADER_HEIGHT + 4 * NODE_ROW_HEIGHT);
  });

  it("caps a collapsed wide table and adds the footer", () => {
    expect(estimateNodeHeight(30, false)).toBe(
      NODE_HEADER_HEIGHT + COLLAPSED_COLUMN_LIMIT * NODE_ROW_HEIGHT + NODE_FOOTER_HEIGHT,
    );
  });

  it("grows with every column when a wide table is expanded (footer holds the collapse button)", () => {
    expect(estimateNodeHeight(30, true)).toBe(
      NODE_HEADER_HEIGHT + 30 * NODE_ROW_HEIGHT + NODE_FOOTER_HEIGHT,
    );
  });

  it("has no footer for a table that never needs collapsing", () => {
    expect(estimateNodeHeight(COLLAPSED_COLUMN_LIMIT, true)).toBe(
      NODE_HEADER_HEIGHT + COLLAPSED_COLUMN_LIMIT * NODE_ROW_HEIGHT,
    );
  });
});
