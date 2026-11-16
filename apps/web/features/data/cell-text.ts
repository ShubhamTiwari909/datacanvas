/**
 * How one cell is shown. Pure, so every rule is tested without a browser.
 *
 * Four kinds of cell must never look alike: SQL NULL, the empty string, a hidden
 * (masked) column, and a value, with a fifth marker for a value that was cut.
 */
import type { RowCell } from "@datacanvas/database-core";

/** Characters of a value shown in the grid; the rest is in the cell dialog. */
export const GRID_CELL_CHARS = 200;

export type CellDisplay =
  | { kind: "null"; text: "NULL" }
  | { kind: "empty"; text: "(empty)" }
  | { kind: "hidden"; text: "hidden" }
  | { kind: "value"; text: string; clipped: boolean };

export function describeCell(cell: RowCell, masked: boolean): CellDisplay {
  if (masked) return { kind: "hidden", text: "hidden" };
  if (cell.value === null) return { kind: "null", text: "NULL" };
  if (cell.value === "") return { kind: "empty", text: "(empty)" };
  // Collapse line breaks for the one-line grid; the dialog shows the value exactly.
  const oneLine = cell.value.replace(/\s+/g, " ");
  if (oneLine.length > GRID_CELL_CHARS) {
    // Do not split an emoji or other surrogate pair in half.
    const last = oneLine.charCodeAt(GRID_CELL_CHARS - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? GRID_CELL_CHARS - 1 : GRID_CELL_CHARS;
    return { kind: "value", text: oneLine.slice(0, end), clipped: true };
  }
  return { kind: "value", text: oneLine, clipped: cell.truncated };
}

/** Does opening this cell show anything the grid does not? Hidden and NULL cells have nothing more to show. */
export const hasMoreToShow = (cell: RowCell, masked: boolean): boolean =>
  !masked &&
  cell.value !== null &&
  cell.value !== "" &&
  (cell.truncated || cell.value.length > GRID_CELL_CHARS || /\s{2,}|\n/.test(cell.value));

/** "1,234 rows" or "about 1.2 million rows": a short, honest size from the planner's estimate. */
export function describeRowEstimate(estimate: number | null): string | null {
  if (estimate === null) return null;
  if (estimate < 1000) return `about ${new Intl.NumberFormat().format(estimate)} rows`;
  const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  return `about ${compact.format(estimate)} rows`;
}
