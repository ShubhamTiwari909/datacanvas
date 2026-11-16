/**
 * The rows of one page as a real table: a caption, a sticky header, monospace
 * values, NULL and the empty string shown differently, hidden columns marked,
 * and keyboard navigation (one cell is a tab stop; arrow keys move; Enter opens
 * a value). Reading only: nothing here edits a cell.
 */
"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import type { RowColumn, RowPage } from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CellDialog, type OpenCell } from "./cell-dialog";
import { describeCell, hasMoreToShow } from "./cell-text";

const CELL_BASE =
  "max-w-xs truncate px-3 py-1.5 align-top font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function DataGrid({
  page,
  caption,
  revealed,
  onReveal,
  onHide,
  busy,
}: {
  page: RowPage;
  caption: string;
  /** Columns the person chose to read although their names look sensitive. */
  revealed: readonly string[];
  onReveal: (column: string) => void;
  onHide: (column: string) => void;
  /** The next page is loading: this one is dimmed, not replaced. */
  busy: boolean;
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [openCell, setOpenCell] = useState<OpenCell | null>(null);

  const lastRow = page.rows.length - 1;
  const lastCol = page.columns.length - 1;

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

  const open = (row: number, col: number) => {
    const column = page.columns[col];
    const cell = page.rows[row]?.[col];
    if (!column || !cell || column.masked || cell.value === null) return;
    setOpenCell({ column, cell });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const target = (event.target as HTMLElement).closest("td");
    if (!target) return;
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
        className={cn(
          "max-h-[70vh] overflow-auto rounded-lg border transition-opacity",
          busy && "opacity-60",
        )}
        aria-busy={busy}
      >
        <table ref={tableRef} role="grid" className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              {page.columns.map((column) => (
                <HeaderCell
                  key={column.name}
                  column={column}
                  revealed={revealed.includes(column.name)}
                  onReveal={onReveal}
                  onHide={onHide}
                />
              ))}
            </tr>
          </thead>
          <tbody onKeyDown={onKeyDown}>
            {page.rows.map((row, r) => (
              <tr key={r} className="border-t hover:bg-muted/40">
                {row.map((cell, c) => {
                  const column = page.columns[c]!;
                  const shown = describeCell(cell, column.masked);
                  const openable = !column.masked && cell.value !== null;
                  return (
                    <td
                      key={c}
                      data-row={r}
                      data-col={c}
                      tabIndex={active.row === r && active.col === c ? 0 : -1}
                      onFocus={() => setActive({ row: r, col: c })}
                      onClick={() => open(r, c)}
                      title={
                        openable && hasMoreToShow(cell, column.masked)
                          ? "Click to see the whole value"
                          : undefined
                      }
                      className={cn(CELL_BASE, openable && "cursor-pointer")}
                    >
                      {shown.kind === "value" ? (
                        <>
                          {shown.text}
                          {shown.clipped ? (
                            <span className="text-muted-foreground" aria-label="(value cut)">
                              …
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span
                          className={cn(
                            "text-muted-foreground",
                            shown.kind !== "hidden" && "italic",
                          )}
                        >
                          {shown.kind === "hidden" ? (
                            <>
                              <span aria-hidden="true">••••••</span>
                              <span className="sr-only">hidden</span>
                            </>
                          ) : (
                            shown.text
                          )}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CellDialog open={openCell} onClose={() => setOpenCell(null)} />
    </>
  );
}

function HeaderCell({
  column,
  revealed,
  onReveal,
  onHide,
}: {
  column: RowColumn;
  revealed: boolean;
  onReveal: (column: string) => void;
  onHide: (column: string) => void;
}) {
  return (
    <th scope="col" className="px-3 py-2 align-bottom font-medium whitespace-nowrap">
      <div className="flex items-center gap-1.5">
        {column.masked ? (
          <Lock className="size-3 text-muted-foreground" aria-hidden="true" />
        ) : null}
        <span className="font-mono text-xs">{column.name}</span>
        {column.masked ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onReveal(column.name)}
            aria-label={`Show the hidden column ${column.name}`}
            title="This column's name looks sensitive, so it was not read. Show it for this view only."
          >
            <Eye aria-hidden="true" />
            Show
          </Button>
        ) : revealed ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onHide(column.name)}
            aria-label={`Hide the column ${column.name} again`}
          >
            <EyeOff aria-hidden="true" />
            Hide
          </Button>
        ) : null}
      </div>
      <div className="font-mono text-[10px] font-normal text-muted-foreground">
        {column.dataType}
      </div>
    </th>
  );
}
