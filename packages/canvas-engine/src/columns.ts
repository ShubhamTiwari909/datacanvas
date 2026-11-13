/**
 * Which columns of a table node are visible, and how tall the node is.
 */
import {
  COLLAPSED_COLUMN_LIMIT,
  NODE_FOOTER_HEIGHT,
  NODE_HEADER_HEIGHT,
  NODE_ROW_HEIGHT,
} from "./constants.js";

/** The columns drawn on the node: all of them when expanded, otherwise the first few. */
export function visibleColumns(columns: readonly string[], expanded: boolean): string[] {
  return expanded ? [...columns] : columns.slice(0, COLLAPSED_COLUMN_LIMIT);
}

/** How many columns a collapsed node hides (0 for a table that fits). */
export function hiddenColumnCount(columnCount: number, expanded: boolean): number {
  return expanded ? 0 : Math.max(0, columnCount - COLLAPSED_COLUMN_LIMIT);
}

/** Height of a node before it has been measured: header + rows (+ footer when columns are hidden). */
export function estimateNodeHeight(columnCount: number, expanded: boolean): number {
  const rows = expanded ? columnCount : Math.min(columnCount, COLLAPSED_COLUMN_LIMIT);
  const footer =
    hiddenColumnCount(columnCount, expanded) > 0 ||
    (expanded && columnCount > COLLAPSED_COLUMN_LIMIT)
      ? NODE_FOOTER_HEIGHT
      : 0;
  return NODE_HEADER_HEIGHT + rows * NODE_ROW_HEIGHT + footer;
}
