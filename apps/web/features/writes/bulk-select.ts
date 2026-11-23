/**
 * Choosing rows for a bulk change (`docs/advanced-data-workspace-plan.md`, section 7; decision 159): the rows are
 * kept BY KEY, in memory, across pages and filters, with the values the person saw in each of their cells, which
 * is what a bulk change is checked against ("only if it still holds what you saw"). Pure functions, no React.
 */
import {
  MAX_BULK_ROWS,
  type DeleteRowsChange,
  type KeyValue,
  type RowCell,
  type RowColumn,
  type TableEditInfo,
  type TableRef,
  type UpdateRowsChange,
} from "@datacanvas/database-core";
import { rowAddress, type BeforeAfterRow } from "./row-edit";

/** One chosen row: its key, and its cells as they were on screen. */
export interface SelectedRow {
  key: KeyValue[];
  cells: Record<string, { value: string | null; truncated: boolean }>;
}

/** The chosen rows, by the key of each (so a row is chosen once, wherever it is shown). */
export type Selection = ReadonlyMap<string, SelectedRow>;

export const EMPTY_SELECTION: Selection = new Map();

/** The identity of a row: its key columns and values (columns in key order, as the table gives them). */
export const rowSignature = (key: readonly KeyValue[]): string =>
  JSON.stringify(key.map((k) => [k.column, k.value]));

/** The row at a position of a page as a chosen row, or null when it cannot be found by its key. */
export function selectedRowAt(
  columns: readonly RowColumn[],
  row: readonly RowCell[],
  info: Pick<TableEditInfo, "editable" | "key" | "reason">,
): SelectedRow | null {
  const address = rowAddress(columns, row, info);
  if (!address.ok) return null;
  const cells: SelectedRow["cells"] = {};
  columns.forEach((column, i) => {
    const cell = row[i];
    // A hidden column was not read: there is nothing to compare with.
    if (cell && !column.masked)
      cells[column.name] = { value: cell.value, truncated: cell.truncated };
  });
  return { key: address.key, cells };
}

export interface PageRows {
  columns: readonly RowColumn[];
  rows: ReadonlyArray<readonly RowCell[]>;
}

/** The chosen row at each position of the page, or null where the row cannot be chosen. */
export function pageSelectable(
  page: PageRows,
  info: Pick<TableEditInfo, "editable" | "key" | "reason">,
): Array<SelectedRow | null> {
  return page.rows.map((row) => selectedRowAt(page.columns, row, info));
}

export type PageState = "none" | "some" | "all";

export function pageState(
  selection: Selection,
  selectable: ReadonlyArray<SelectedRow | null>,
): PageState {
  const rows = selectable.filter((r): r is SelectedRow => r !== null);
  if (rows.length === 0) return "none";
  const chosen = rows.filter((r) => selection.has(rowSignature(r.key))).length;
  return chosen === 0 ? "none" : chosen === rows.length ? "all" : "some";
}

export interface Toggled {
  selection: Selection;
  /** The position that a shift-click extends from. */
  anchor: number | null;
  /** True when the limit stopped some rows from being added. */
  limited: boolean;
}

/**
 * Choose or let go of one row (and, with `extend`, every row between the last one clicked and this one, all set
 * the way the clicked row is going to be). At most `MAX_BULK_ROWS` rows can be chosen in all.
 */
export function toggleRow(
  selection: Selection,
  selectable: ReadonlyArray<SelectedRow | null>,
  at: number,
  extend: boolean,
  anchor: number | null,
): Toggled {
  const clicked = selectable[at];
  if (!clicked) return { selection, anchor, limited: false };
  const adding = !selection.has(rowSignature(clicked.key));
  const from = extend && anchor !== null ? Math.min(anchor, at) : at;
  const to = extend && anchor !== null ? Math.max(anchor, at) : at;
  const next = new Map(selection);
  let limited = false;
  for (let i = from; i <= to; i++) {
    const row = selectable[i];
    if (!row) continue;
    const sig = rowSignature(row.key);
    if (!adding) {
      next.delete(sig);
    } else if (!next.has(sig)) {
      if (next.size >= MAX_BULK_ROWS) limited = true;
      else next.set(sig, row);
    }
  }
  return { selection: next, anchor: at, limited };
}

/** Choose every row of the page, or (when all are chosen) let go of them. */
export function togglePage(
  selection: Selection,
  selectable: ReadonlyArray<SelectedRow | null>,
): Toggled {
  const rows = selectable.filter((r): r is SelectedRow => r !== null);
  const allChosen = rows.length > 0 && rows.every((r) => selection.has(rowSignature(r.key)));
  const next = new Map(selection);
  let limited = false;
  for (const row of rows) {
    const sig = rowSignature(row.key);
    if (allChosen) next.delete(sig);
    else if (!next.has(sig)) {
      if (next.size >= MAX_BULK_ROWS) limited = true;
      else next.set(sig, row);
    }
  }
  return { selection: next, anchor: null, limited };
}

// ------------------------------------------------------- building changes ---

const tableOf = (table: TableRef): TableRef => ({ schema: table.schema, name: table.name });

export interface BuiltUpdate {
  change: UpdateRowsChange;
  /** The chosen rows left out because the value they hold in this column was cut (so it cannot be compared). */
  leftOut: number;
}

/** Set one column to one value on the chosen rows, each checked against the value it was seen holding. */
export function buildUpdateRows(
  table: TableRef,
  rows: readonly SelectedRow[],
  column: string,
  value: string | null,
): BuiltUpdate | null {
  const usable = rows.filter((r) => {
    const cell = r.cells[column];
    return cell !== undefined && !cell.truncated;
  });
  if (usable.length === 0) return null;
  return {
    leftOut: rows.length - usable.length,
    change: {
      kind: "update_rows",
      table: tableOf(table),
      set: [{ column, value }],
      rows: usable.map((r) => ({
        key: r.key.map((k) => ({ column: k.column, value: k.value })),
        expected: [{ column, value: r.cells[column]!.value }],
      })),
    },
  };
}

export function buildDeleteRows(table: TableRef, rows: readonly SelectedRow[]): DeleteRowsChange {
  return {
    kind: "delete_rows",
    table: tableOf(table),
    rows: rows.map((r) => ({ key: r.key.map((k) => ({ column: k.column, value: k.value })) })),
  };
}

/** The most rows shown in the before and after table of a bulk change. */
export const BULK_PREVIEW_ROWS = 10;

const shownValue = (value: string | null, cut = false): BeforeAfterRow["before"] =>
  value === null ? { kind: "null" } : { kind: "value", text: value, cut };

/** The first rows of a bulk update, as they were and as they will be, labelled by their key. */
export function bulkUpdateBeforeAfter(
  rows: readonly SelectedRow[],
  column: string,
  value: string | null,
): BeforeAfterRow[] {
  // The rows that will be written (a value that was cut cannot be compared), then the first of them.
  return rows
    .filter((r) => {
      const cell = r.cells[column];
      return cell !== undefined && !cell.truncated;
    })
    .slice(0, BULK_PREVIEW_ROWS)
    .map((r) => ({
      column: r.key.map((k) => `${k.column} ${k.value}`).join(", "),
      before: shownValue(r.cells[column]!.value),
      after: shownValue(value),
    }));
}

/** The first rows of a bulk delete, labelled by their key. */
export function bulkDeleteBeforeAfter(rows: readonly SelectedRow[]): BeforeAfterRow[] {
  return rows.slice(0, BULK_PREVIEW_ROWS).map((r) => ({
    column: r.key.map((k) => `${k.column} ${k.value}`).join(", "),
    before: { kind: "none" },
    after: { kind: "deleted" },
  }));
}
