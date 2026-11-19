/**
 * The rows of a result as a real table: a caption, a sticky header, monospace values, NULL
 * and the empty string shown differently, and keyboard navigation (one cell is a tab stop;
 * arrows move; Enter opens a value). It is read-only and knows nothing of tables: a result
 * has columns and text, no key, no order and no masking (decision 141).
 *
 * The look of a cell is `describeCell`, the same as the Data tab's, and a long value opens in
 * the same cell dialog.
 */
"use client";

import { memo, useCallback, useRef, useState, type KeyboardEvent } from "react";
import type { RowCell, RowColumn } from "@datacanvas/database-core";
import type { SqlResult } from "@datacanvas/shared-types";
import { cn } from "@/lib/utils";
import { BLUR_IN_GRID, useBlurStore } from "@/features/data/blur-store";
import { CellDialog, type OpenCell } from "@/features/data/cell-dialog";
import { describeCell, hasMoreToShow } from "@/features/data/cell-text";

const CELL =
  "max-w-xs truncate px-3 py-1.5 align-top font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

const toColumn = (c: SqlResult["columns"][number]): RowColumn => ({
  name: c.name,
  dataType: c.dataType,
  masked: false,
  kind: "other",
});
const toCell = (value: string | null): RowCell => ({ value, truncated: false });

export function ResultGrid({ result }: { result: SqlResult }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [openCell, setOpenCell] = useState<OpenCell | null>(null);
  const blurred = useBlurStore((s) => s.blurred);

  const columns = result.columns.map(toColumn);
  const lastRow = result.rows.length - 1;
  const lastCol = columns.length - 1;

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

  const open = useCallback(
    (row: number, col: number) => {
      const value = result.rows[row]?.[col];
      const column = result.columns[col];
      if (value === undefined || value === null || !column) return;
      setOpenCell({ column: toColumn(column), cell: toCell(value) });
    },
    [result],
  );
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
      open(row, col);
    }
  };

  return (
    <>
      <div
        data-blurred={blurred}
        className="group/grid h-full min-h-0 overflow-auto rounded-lg border"
      >
        <table ref={tableRef} role="grid" className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Query result</caption>
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th
                scope="col"
                className="w-0 px-3 py-2 text-right text-xs font-normal text-muted-foreground"
              >
                #
              </th>
              {columns.map((column, c) => (
                <th
                  key={c}
                  scope="col"
                  title={column.dataType}
                  className="px-3 py-2 align-bottom font-mono text-xs font-medium whitespace-nowrap"
                >
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody onKeyDown={onKeyDown}>
            {result.rows.map((row, r) => (
              <GridRow
                key={r}
                row={row}
                r={r}
                activeCol={active.row === r ? active.col : -1}
                onActivate={activate}
                onOpen={open}
              />
            ))}
          </tbody>
        </table>
      </div>
      <CellDialog open={openCell} onClose={() => setOpenCell(null)} />
    </>
  );
}

/** One body row, memoised so that moving between cells re-renders two rows, not a whole page. */
const GridRow = memo(function GridRow({
  row,
  r,
  activeCol,
  onActivate,
  onOpen,
}: {
  row: (string | null)[];
  r: number;
  /** The focusable column of this row, or -1 when the row has no tab stop. */
  activeCol: number;
  onActivate: (row: number, col: number) => void;
  onOpen: (row: number, col: number) => void;
}) {
  return (
    <tr className="border-t hover:bg-muted/40">
      <th
        scope="row"
        className="px-3 py-1.5 text-right align-top font-mono text-xs font-normal text-muted-foreground"
      >
        {r + 1}
      </th>
      {row.map((value, c) => {
        const cell = toCell(value);
        const shown = describeCell(cell, false);
        const openable = value !== null;
        return (
          <td
            key={c}
            data-row={r}
            data-col={c}
            tabIndex={activeCol === c ? 0 : -1}
            onFocus={() => onActivate(r, c)}
            onClick={() => onOpen(r, c)}
            title={
              openable && hasMoreToShow(cell, false) ? "Click to see the whole value" : undefined
            }
            className={cn(CELL, openable && "cursor-pointer")}
          >
            {shown.kind === "value" ? (
              <>
                <span className={BLUR_IN_GRID}>{shown.text}</span>
                {shown.clipped ? (
                  <span className="text-muted-foreground" aria-label="(value cut)">
                    …
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground italic">{shown.text}</span>
            )}
          </td>
        );
      })}
    </tr>
  );
});
