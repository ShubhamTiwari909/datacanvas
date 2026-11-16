/**
 * Sorting, as the person sees it: which columns can be sorted, what a click on a
 * header does, and how a sort is described in words. Pure: no React, no rows.
 */
import {
  canSortRows,
  type RowColumn,
  type RowOrder,
  type RowSort,
} from "@datacanvas/database-core";

export type SortState = "ascending" | "descending" | "none";

/** What a column's sort is right now: the value of its header's `aria-sort`. */
export function sortStateOf(sort: RowSort | null, column: string): SortState {
  if (sort === null || sort.column !== column) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

/**
 * What activating a column's header does: sort ascending, then descending, then back to the key order.
 * Choosing another column starts that column at ascending.
 */
export function nextSort(current: RowSort | null, column: string): RowSort | null {
  if (current === null || current.column !== column) return { column, direction: "asc" };
  return current.direction === "asc" ? { column, direction: "desc" } : null;
}

/** What the header's button says it will do (its tooltip). */
export function sortActionLabel(sort: RowSort | null, column: string): string {
  const state = sortStateOf(sort, column);
  return state === "none"
    ? "Sort ascending"
    : state === "ascending"
      ? "Sort descending"
      : "Remove the sort";
}

/**
 * Why a column cannot be sorted, in a sentence for a tooltip; null when it can. Hidden columns come first:
 * ordering by one would read it back one comparison at a time.
 */
export function whyNotSortable(column: RowColumn, order: RowOrder): string | null {
  if (canSortRows(column, order)) return null;
  if (column.masked) return "A hidden column cannot be sorted. Show it first.";
  if (order.kind === "none") {
    return "This table has no primary key or unique index, so it cannot be sorted reliably.";
  }
  return "The values of this type have no useful order to sort by.";
}

const keyKind = (order: RowOrder): string =>
  order.kind === "primary_key" ? "the primary key" : "a unique index";

/** "city, ascending (NULL last), then id (the primary key)": how the page is ordered, for the note under the grid. */
export function describeSort(sort: RowSort, order: RowOrder): string {
  const direction = sort.direction === "asc" ? "ascending, NULL last" : "descending, NULL first";
  const tieBreaker =
    order.kind === "none" ? "" : `, then by ${order.columns.join(", ")} (${keyKind(order)})`;
  return `${sort.column} (${direction})${tieBreaker}`;
}
