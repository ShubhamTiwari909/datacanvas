/**
 * Cells edited in the grid and not sent yet (`docs/write-side-v2-plan.md`, section 5): the pending changes of an
 * `edit_cells` change, as a reducer with no React, so every rule is tested on its own.
 *
 * Each pending cell keeps the value the person saw when they first edited it (`before`, what the change is checked
 * against) and the value they want (`after`). Editing a cell back to what it was removes it. Every step can be undone
 * (the browser's own undo: nothing was written). The limits of the operation are kept here, so the grid never builds
 * a change the server would refuse for its size. Nothing here is stored anywhere but in memory.
 */
import {
  EDIT_CELLS_MAX_CELLS,
  EDIT_CELLS_MAX_CELLS_PER_ROW,
  MAX_BULK_ROWS,
  type EditCellsChange,
  type EditableColumn,
  type KeyValue,
  type RowCell,
  type RowColumn,
  type TableRef,
} from "@datacanvas/database-core";
import { rowSignature } from "./bulk-select";
import { cellEditBlock } from "./row-edit";

/** Why a key column is not edited in the grid (decision 7 of the plan): a key is changed in the row's form. */
export const KEY_CELL_TEXT =
  "This column is part of the key that finds the row, so it is not edited in the grid. Change it with Edit row, one row at a time.";

/**
 * Why one cell cannot be edited in the grid, or null when it can: the row cannot be found by its key (`rowBlock`),
 * the column is part of the key, or the row form's own rules (hidden, filled by the database, `bytea`, cut).
 */
export function gridCellBlock(
  rowBlock: string | null,
  column: Pick<RowColumn, "name" | "masked">,
  cell: RowCell,
  info: EditableColumn | undefined,
): string | null {
  if (rowBlock !== null) return rowBlock;
  if (info?.inKey) return KEY_CELL_TEXT;
  return cellEditBlock(column, cell, info);
}

/** One pending cell: the column, the value seen when it was first edited, and the value wanted (`null` is NULL). */
export interface PendingCell {
  column: string;
  before: string | null;
  after: string | null;
}

/** A row with pending cells, found by its whole key; its cells in the order they were first edited. */
export interface PendingRow {
  signature: string;
  key: KeyValue[];
  cells: PendingCell[];
}

/** What one step changed, to put it back: the cell's wanted value before the step (`undefined`: it was not pending). */
interface UndoStep {
  signature: string;
  key: KeyValue[];
  column: string;
  before: string | null;
  previous: string | null | undefined;
}

export interface PendingState {
  /** The rows in the order they were first edited. */
  rows: PendingRow[];
  undo: UndoStep[];
  /** Why the last edit was not kept (a limit), or null. */
  refusal: string | null;
}

export const EMPTY_PENDING: PendingState = { rows: [], undo: [], refusal: null };

export type PendingAction =
  /** Set a cell to `after`; `before` is the value on screen (used only when the cell is not pending yet). */
  | { type: "set"; key: KeyValue[]; column: string; before: string | null; after: string | null }
  /** Take one pending cell back (from the review). */
  | { type: "revert"; signature: string; column: string }
  | { type: "undo" }
  | { type: "discard" }
  /** Drop the cells of the columns that may no longer be edited (a column hidden again). Not undoable. */
  | { type: "prune"; keep: (column: string) => boolean };

export const ROWS_LIMIT_TEXT = `At most ${MAX_BULK_ROWS.toLocaleString("en-US")} rows can be edited in one change. Review and apply these first.`;
export const ROW_CELLS_LIMIT_TEXT = `At most ${EDIT_CELLS_MAX_CELLS_PER_ROW} cells of one row can be edited in one change. Review and apply these first.`;
export const CELLS_LIMIT_TEXT = `At most ${EDIT_CELLS_MAX_CELLS.toLocaleString("en-US")} cells can be edited in one change. Review and apply these first.`;

const copyKey = (key: readonly KeyValue[]): KeyValue[] =>
  key.map((k) => ({ column: k.column, value: k.value }));

export function countPending(state: PendingState): { cells: number; rows: number } {
  return {
    cells: state.rows.reduce((sum, row) => sum + row.cells.length, 0),
    rows: state.rows.length,
  };
}

/**
 * Put one cell in a state: `after` undefined takes it out. Rows that are left with no cell go. Limits are not checked
 * here (the callers do).
 */
function place(
  rows: readonly PendingRow[],
  key: readonly KeyValue[],
  column: string,
  before: string | null,
  after: string | null | undefined,
): PendingRow[] {
  const signature = rowSignature(key);
  const at = rows.findIndex((r) => r.signature === signature);
  const row = at === -1 ? null : rows[at]!;
  const cells = row ? row.cells.filter((c) => c.column !== column) : [];
  if (after !== undefined) {
    const old = row?.cells.findIndex((c) => c.column === column) ?? -1;
    const cell = { column, before, after };
    // A cell that was pending keeps its place; a new one goes last.
    if (old === -1) cells.push(cell);
    else cells.splice(old, 0, cell);
  }
  if (row === null) {
    return cells.length === 0 ? [...rows] : [...rows, { signature, key: copyKey(key), cells }];
  }
  const next = [...rows];
  if (cells.length === 0) next.splice(at, 1);
  else next[at] = { ...row, cells };
  return next;
}

function findCell(
  rows: readonly PendingRow[],
  signature: string,
  column: string,
): { row: PendingRow | null; cell: PendingCell | null } {
  const row = rows.find((r) => r.signature === signature) ?? null;
  return { row, cell: row?.cells.find((c) => c.column === column) ?? null };
}

export function pendingReducer(state: PendingState, action: PendingAction): PendingState {
  switch (action.type) {
    case "set": {
      const signature = rowSignature(action.key);
      const { row, cell } = findCell(state.rows, signature, action.column);
      const original = cell ? cell.before : action.before;
      const previous = cell ? cell.after : undefined;
      // Back to what was seen: the cell is not pending any more.
      const wanted = action.after === original ? undefined : action.after;
      if (wanted === previous) return state.refusal === null ? state : { ...state, refusal: null };
      if (cell === null) {
        const counts = countPending(state);
        const refusal =
          row === null && state.rows.length >= MAX_BULK_ROWS
            ? ROWS_LIMIT_TEXT
            : row !== null && row.cells.length >= EDIT_CELLS_MAX_CELLS_PER_ROW
              ? ROW_CELLS_LIMIT_TEXT
              : counts.cells >= EDIT_CELLS_MAX_CELLS
                ? CELLS_LIMIT_TEXT
                : null;
        if (refusal !== null) return { ...state, refusal };
      }
      return {
        rows: place(state.rows, action.key, action.column, original, wanted),
        undo: [
          ...state.undo,
          {
            signature,
            key: copyKey(action.key),
            column: action.column,
            before: original,
            previous,
          },
        ],
        refusal: null,
      };
    }
    case "revert": {
      const { row, cell } = findCell(state.rows, action.signature, action.column);
      if (!row || !cell) return state;
      return {
        rows: place(state.rows, row.key, cell.column, cell.before, undefined),
        undo: [
          ...state.undo,
          {
            signature: row.signature,
            key: copyKey(row.key),
            column: cell.column,
            before: cell.before,
            previous: cell.after,
          },
        ],
        refusal: null,
      };
    }
    case "undo": {
      const step = state.undo.at(-1);
      if (!step) return state.refusal === null ? state : { ...state, refusal: null };
      return {
        rows: place(state.rows, step.key, step.column, step.before, step.previous),
        undo: state.undo.slice(0, -1),
        refusal: null,
      };
    }
    case "discard":
      return EMPTY_PENDING;
    case "prune": {
      const rows = state.rows.flatMap((row) => {
        const cells = row.cells.filter((c) => action.keep(c.column));
        return cells.length === 0
          ? []
          : [cells.length === row.cells.length ? row : { ...row, cells }];
      });
      const undo = state.undo.filter((s) => action.keep(s.column));
      if (rows.length === state.rows.length && undo.length === state.undo.length) {
        const same = rows.every((r, i) => r === state.rows[i]);
        if (same) return state;
      }
      return { rows, undo, refusal: null };
    }
  }
}

/** The pending rows by signature, for the grid to look a cell up. */
export function pendingBySignature(state: PendingState): ReadonlyMap<string, PendingRow> {
  return new Map(state.rows.map((r) => [r.signature, r]));
}

/** "3 cells in 2 rows changed". */
export function pendingText(counts: { cells: number; rows: number }): string {
  const n = (count: number, one: string) =>
    `${count.toLocaleString("en-US")} ${count === 1 ? one : `${one}s`}`;
  return `${n(counts.cells, "cell")} in ${n(counts.rows, "row")} changed`;
}

/** "N cells were changed." (after the apply). */
export function appliedCellsText(cells: number): string {
  return `${cells.toLocaleString("en-US")} ${cells === 1 ? "cell was" : "cells were"} changed.`;
}

/** A row named by its key, as the bulk changes name them: "id 3", or "a 1, b x" for a composite key. */
export const keyLabel = (key: readonly KeyValue[]): string =>
  key.map((k) => `${k.column} ${k.value}`).join(", ");

/** The `edit_cells` change for every pending cell, or null when nothing is pending. */
export function buildEditCells(
  table: TableRef,
  state: PendingState,
  revealColumns: readonly string[],
): EditCellsChange | null {
  if (state.rows.length === 0) return null;
  return {
    kind: "edit_cells",
    table: { schema: table.schema, name: table.name },
    revealColumns: [...revealColumns],
    rows: state.rows.map((row) => ({
      key: copyKey(row.key),
      changes: row.cells.map((c) => ({ column: c.column, value: c.after, expected: c.before })),
    })),
  };
}

/** How many cells an applied change wrote: every cell of the rows the preview did not leave out (by position). */
export function cellsWritten(change: EditCellsChange, skipped: readonly number[]): number {
  const out = new Set(skipped);
  return change.rows.reduce((sum, row, i) => (out.has(i) ? sum : sum + row.changes.length), 0);
}
