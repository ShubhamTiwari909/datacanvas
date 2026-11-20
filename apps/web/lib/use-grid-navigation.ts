/**
 * Keyboard movement in a grid of cells (`role="grid"`): one cell holds the tab stop, the arrow
 * keys, Home, End, Page Up and Page Down move it, Enter or Space opens the cell. Shared by the
 * grids that show rows, so each behaves the same and a fix is made once.
 *
 * The cells are `td` elements with `data-row` and `data-col`; the grid's `tbody` gets `onKeyDown`.
 */
import { useCallback, useRef, useState, type KeyboardEvent } from "react";

export interface GridNavigation {
  tableRef: React.RefObject<HTMLTableElement | null>;
  /** The cell that has the tab stop (kept inside the grid when the grid shrinks). */
  active: { row: number; col: number };
  /** Make a cell the tab stop (a click, a focus). */
  activate: (row: number, col: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTableSectionElement>) => void;
}

export function useGridNavigation({
  rows,
  columns,
  onOpen,
  onKey,
}: {
  rows: number;
  columns: number;
  /** Enter or Space on a cell. */
  onOpen: (row: number, col: number) => void;
  /** A key this grid handles itself (F2 to edit): return true when it did. */
  onKey?: (event: KeyboardEvent<HTMLTableSectionElement>, row: number, col: number) => boolean;
}): GridNavigation {
  const tableRef = useRef<HTMLTableElement>(null);
  const [raw, setActive] = useState({ row: 0, col: 0 });
  const lastRow = rows - 1;
  const lastCol = columns - 1;
  const active = {
    row: Math.min(raw.row, Math.max(0, lastRow)),
    col: Math.min(raw.col, Math.max(0, lastCol)),
  };

  const focusCell = (row: number, col: number) => {
    const next = {
      row: Math.max(0, Math.min(lastRow, row)),
      col: Math.max(0, Math.min(lastCol, col)),
    };
    setActive(next);
    tableRef.current
      ?.querySelector<HTMLElement>(`td[data-row="${next.row}"][data-col="${next.col}"]`)
      ?.focus();
  };
  const activate = useCallback((row: number, col: number) => setActive({ row, col }), []);

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const target = (event.target as HTMLElement).closest("td");
    if (!target || target.dataset.row === undefined) return;
    const row = Number(target.dataset.row);
    const col = Number(target.dataset.col);
    const moves: Record<string, [number, number]> = {
      ArrowDown: [row + 1, col],
      ArrowUp: [row - 1, col],
      ArrowRight: [row, col + 1],
      ArrowLeft: [row, col - 1],
      Home: [row, 0],
      End: [row, lastCol],
      PageDown: [row + 10, col],
      PageUp: [row - 10, col],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      focusCell(move[0], move[1]);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(row, col);
    } else if (onKey?.(event, row, col)) {
      event.preventDefault();
    }
  };

  return { tableRef, active, activate, onKeyDown };
}
