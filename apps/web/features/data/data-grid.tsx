/**
 * The rows of one page as a real table: a caption, a sticky header, monospace
 * values, NULL and the empty string shown differently, hidden columns marked,
 * and keyboard navigation (one cell is a tab stop; arrow keys move; Enter opens
 * a value). With writes unlocked (1.4.0) each row gets Edit and Delete buttons
 * and F2 opens the row's editor. A double click on a cell, or Enter (1.12.0),
 * edits the cell in place: the value becomes a pending change, marked in the
 * grid, and nothing is written until the pending changes are reviewed and
 * previewed together.
 */
"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Eye,
  EyeOff,
  Lock,
  Pencil,
  PencilLine,
  Trash2,
} from "lucide-react";
import type { RowCell, RowColumn, RowFilter, RowPage, RowSort } from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useGridNavigation } from "@/lib/use-grid-navigation";
import { CellEditor } from "@/features/writes/cell-editor";
import type { PendingRow } from "@/features/writes/pending-cells";
import { BLUR_IN_GRID, useBlurStore } from "./blur-store";
import { wholeCellKey } from "@/features/json/cell-key";
import { CellDialog, type CellSource, type OpenCell } from "./cell-dialog";
import { describeCell, hasMoreToShow } from "./cell-text";
import { sortActionLabel, sortStateOf, whyNotSortable, type SortState } from "./sorting";

/** What the grid needs to offer editing (only passed while writes are unlocked and the table is editable). */
export interface GridEditing {
  /** Why this row cannot be edited or deleted, or null when it can. */
  rowBlock: (row: number) => string | null;
  /** Edit a row, starting at a column (by index) if one was chosen. */
  onEdit: (row: number, col: number | null) => void;
  onDelete: (row: number) => void;
  /** Editing cells in place, with pending changes (1.12.0); absent where only rows are edited. */
  cells?: GridCellEditing | null;
}

/** Editing cells in place: which cells can be edited, the pending changes, and setting one. */
export interface GridCellEditing {
  /** Why this cell cannot be edited in place, or null when it can. */
  cellBlock: (row: number, col: number) => string | null;
  /** The pending changes of the row at a position, or null. */
  pendingRow: (row: number) => PendingRow | null;
  /** Whether a column may hold NULL. */
  nullable: (column: string) => boolean;
  /** Keep a value as the pending change of a cell (the value on screen when it was the same removes it). */
  onSet: (row: number, col: number, value: string | null) => void;
  /** Take the last pending step back. */
  onUndo: () => void;
}

/** A click that may be the first of a double click waits this long before it opens the value. */
const DOUBLE_CLICK_MS = 250;

/** What the grid needs to let rows be chosen for a bulk change (only passed while writes are unlocked and the table is editable). */
export interface GridSelection {
  isSelected: (row: number) => boolean;
  /** Choose or let go of a row; `extend` (shift) does the same for every row from the last one clicked. */
  onToggle: (row: number, extend: boolean) => void;
  /** Whether the rows of this page are none, some or all chosen. */
  pageState: "none" | "some" | "all";
  onTogglePage: () => void;
}

const CELL_BASE =
  "max-w-xs truncate px-3 py-1.5 align-top font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function DataGrid({
  page,
  caption,
  revealed,
  onReveal,
  onHide,
  sort,
  onSort,
  busy,
  editing = null,
  selection = null,
  onFilterCell,
  source,
}: {
  page: RowPage;
  caption: string;
  /** Columns the person chose to read although their names look sensitive. */
  revealed: readonly string[];
  onReveal: (column: string) => void;
  onHide: (column: string) => void;
  /** The sort the person chose (null: the key order), and what activating a column's header asks for. */
  sort: RowSort | null;
  onSort: (column: string) => void;
  /** The next page is loading: this one is dimmed, not replaced. */
  busy: boolean;
  /** Row actions, while writes are unlocked. */
  editing?: GridEditing | null;
  /** Choosing rows for a bulk change, while writes are unlocked. */
  selection?: GridSelection | null;
  /** A condition made from a cell ("Filter by this value"), or absent when no more can be added. */
  onFilterCell?: (filter: RowFilter) => void;
  /** The table the page is from, so a cut JSON value can be read whole. */
  source?: CellSource;
}) {
  const [openCell, setOpenCell] = useState<OpenCell | null>(null);
  const blurred = useBlurStore((s) => s.blurred);
  const cells = editing?.cells ?? null;
  // The cell being edited in place, on the page it was opened on (another page closes it).
  const [editor, setEditor] = useState<{ row: number; col: number; page: RowPage } | null>(null);
  const editorAt = editor && editor.page === page ? editor : null;

  const open = useCallback(
    (row: number, col: number) => {
      const column = page.columns[col];
      const cell = page.rows[row]?.[col];
      if (!column || !cell || column.masked || cell.value === null) return;
      setOpenCell({ column, cell, key: wholeCellKey(page, row) });
    },
    [page],
  );
  const { tableRef, active, activate, onKeyDown } = useGridNavigation({
    rows: page.rows.length,
    columns: page.columns.length,
    onOpen: open,
    onKey: (event, row, col) => {
      const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (event.key === "Enter" && plain && cells && cells.cellBlock(row, col) === null) {
        setEditor({ row, col, page });
        return true;
      }
      if (
        cells &&
        event.key.toLowerCase() === "z" &&
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        cells.onUndo();
        return true;
      }
      if (event.key === "F2" && editing && editing.rowBlock(row) === null) {
        editing.onEdit(row, col);
        return true;
      }
      return false;
    },
  });

  // A single click on a cell that can be edited waits to see whether it is the first of a double click.
  const clickTimer = useRef<number | null>(null);
  const stopClickTimer = () => {
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    clickTimer.current = null;
  };
  useEffect(
    () => () => {
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    },
    [],
  );
  const onCellClick = useCallback(
    (row: number, col: number, detail: number) => {
      if (!cells || cells.cellBlock(row, col) !== null) {
        open(row, col);
        return;
      }
      stopClickTimer();
      if (detail > 1) return;
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null;
        open(row, col);
      }, DOUBLE_CLICK_MS);
    },
    [cells, open],
  );
  const onCellDoubleClick = useCallback(
    (row: number, col: number) => {
      stopClickTimer();
      if (cells && cells.cellBlock(row, col) === null) {
        activate(row, col);
        setEditor({ row, col, page });
      } else if (editing && editing.rowBlock(row) === null) {
        editing.onEdit(row, col);
      }
    },
    [cells, editing, activate, page],
  );
  const onEditorDone = useCallback(
    (row: number, col: number, value: string | null | undefined, refocus: boolean) => {
      if (value !== undefined) cells?.onSet(row, col, value);
      setEditor(null);
      // Back to the cell, so the keyboard carries on from where it was (not when focus left for something else).
      if (refocus) {
        tableRef.current
          ?.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`)
          ?.focus();
      }
    },
    [cells, tableRef],
  );

  return (
    <>
      <div
        data-blurred={blurred}
        className={cn(
          "group/grid max-h-[70vh] overflow-auto rounded-lg border transition-opacity",
          busy && "opacity-60",
        )}
        aria-busy={busy}
      >
        <table ref={tableRef} role="grid" className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">
            {caption}
            {cells
              ? ". Press Enter or double-click on a cell to edit it, and Space to see its value."
              : null}
          </caption>
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              {selection ? (
                <th scope="col" className="w-0 px-2 py-2">
                  <PageCheckbox state={selection.pageState} onToggle={selection.onTogglePage} />
                </th>
              ) : null}
              {editing ? (
                <th scope="col" className="w-0 px-2 py-2">
                  <span className="sr-only">Row actions</span>
                </th>
              ) : null}
              {page.columns.map((column) => (
                <HeaderCell
                  key={column.name}
                  column={column}
                  revealed={revealed.includes(column.name)}
                  onReveal={onReveal}
                  onHide={onHide}
                  sort={sort}
                  whyNot={whyNotSortable(column, page.order)}
                  onSort={onSort}
                />
              ))}
            </tr>
          </thead>
          <tbody onKeyDown={onKeyDown}>
            {page.rows.map((row, r) => (
              <GridRow
                key={r}
                row={row}
                r={r}
                columns={page.columns}
                activeCol={active.row === r ? active.col : -1}
                onActivate={activate}
                onCellClick={onCellClick}
                onCellDoubleClick={onCellDoubleClick}
                editing={editing}
                selection={selection}
                selected={selection ? selection.isSelected(r) : false}
                pending={cells ? cells.pendingRow(r) : null}
                editorCol={editorAt?.row === r ? editorAt.col : -1}
                onEditorDone={onEditorDone}
              />
            ))}
          </tbody>
        </table>
      </div>
      <CellDialog
        open={openCell}
        onClose={() => setOpenCell(null)}
        onFilter={onFilterCell}
        source={source}
      />
    </>
  );
}

/**
 * One body row. It is memoised so that moving between cells re-renders the two
 * rows involved, not every cell of a wide page.
 */
const GridRow = memo(function GridRow({
  row,
  r,
  columns,
  activeCol,
  onActivate,
  onCellClick,
  onCellDoubleClick,
  editing,
  selection,
  selected,
  pending,
  editorCol,
  onEditorDone,
}: {
  row: RowCell[];
  r: number;
  columns: RowColumn[];
  /** The focusable column of this row, or -1 when the row has no tab stop. */
  activeCol: number;
  onActivate: (row: number, col: number) => void;
  /** `detail` is the click count of the event (2 for the second click of a double click). */
  onCellClick: (row: number, col: number, detail: number) => void;
  onCellDoubleClick: (row: number, col: number) => void;
  editing: GridEditing | null;
  selection: GridSelection | null;
  /** Whether this row is chosen (a prop, so that a memoised row re-renders when it changes). */
  selected: boolean;
  /** The pending changes of this row (a prop, so that a memoised row re-renders when they change). */
  pending: PendingRow | null;
  /** The column being edited in place in this row, or -1. */
  editorCol: number;
  /** The in-place editor is done: `value` undefined when it was cancelled. */
  onEditorDone: (
    row: number,
    col: number,
    value: string | null | undefined,
    refocus: boolean,
  ) => void;
}) {
  const block = editing ? editing.rowBlock(r) : null;
  const cells = editing?.cells ?? null;
  return (
    <tr className={cn("border-t hover:bg-muted/40", selected && "bg-muted/60")}>
      {selection ? (
        <td className="px-2 py-0 align-middle">
          <input
            type="checkbox"
            className={cn(
              "size-4 align-middle accent-primary",
              block !== null && "cursor-not-allowed opacity-40",
            )}
            aria-label={`Select row ${r + 1}`}
            title={block ?? undefined}
            checked={selected}
            aria-disabled={block !== null}
            onChange={() => undefined}
            onClick={(event) => {
              // Not `disabled`: that drops the box out of keyboard focus, and with it the reason in the title.
              if (block !== null) event.preventDefault();
              else selection.onToggle(r, event.shiftKey);
            }}
          />
        </td>
      ) : null}
      {editing ? (
        <td className="px-1 py-0 align-middle whitespace-nowrap">
          <RowActionButton
            label={`Edit row ${r + 1}`}
            block={block}
            onClick={() => editing.onEdit(r, null)}
          >
            <Pencil aria-hidden="true" />
          </RowActionButton>
          <RowActionButton
            label={`Delete row ${r + 1}`}
            block={block}
            onClick={() => editing.onDelete(r)}
          >
            <Trash2 aria-hidden="true" />
          </RowActionButton>
        </td>
      ) : null}
      {row.map((read, c) => {
        const column = columns[c]!;
        const change = pending?.cells.find((p) => p.column === column.name) ?? null;
        // A pending cell shows the value it will get; the rest show what was read.
        const cell: RowCell = change ? { value: change.after, truncated: false } : read;
        const shown = describeCell(cell, column.masked);
        const openable = !column.masked && cell.value !== null;
        // Why the cell cannot be edited in place, said as its description (and a tooltip) while editing is on.
        const why = cells ? cells.cellBlock(r, c) : null;
        if (editorCol === c && cells && why === null) {
          return (
            <td key={c} data-row={r} data-col={c} tabIndex={-1} className="px-1 py-1 align-top">
              <CellEditor
                column={column}
                value={cell.value}
                original={change ? change.before : read.value}
                nullable={cells.nullable(column.name)}
                onCommit={(value, refocus) => onEditorDone(r, c, value, refocus)}
                onCancel={() => onEditorDone(r, c, undefined, true)}
              />
            </td>
          );
        }
        const title = [
          change ? "Changed, not saved yet." : null,
          openable && hasMoreToShow(cell, column.masked) ? "Click to see the whole value" : null,
          why,
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <td
            key={c}
            data-row={r}
            data-col={c}
            data-pending={change ? "" : undefined}
            tabIndex={activeCol === c ? 0 : -1}
            onFocus={() => onActivate(r, c)}
            onClick={(event) => onCellClick(r, c, event.detail)}
            onDoubleClick={editing ? () => onCellDoubleClick(r, c) : undefined}
            title={title || undefined}
            className={cn(
              CELL_BASE,
              openable && "cursor-pointer",
              change && "bg-amber-500/10 dark:bg-amber-400/10",
            )}
          >
            {change ? (
              <PencilLine
                aria-hidden="true"
                className="mr-1 inline size-3 align-[-1px] text-amber-700 dark:text-amber-400"
              />
            ) : null}
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
              <span className={cn("text-muted-foreground", shown.kind !== "hidden" && "italic")}>
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
            {change ? <span className="sr-only"> (changed)</span> : null}
          </td>
        );
      })}
    </tr>
  );
});

/** The checkbox of the header: chooses the rows of the page, or lets go of them; "some" is shown as mixed. */
function PageCheckbox({
  state,
  onToggle,
}: {
  state: "none" | "some" | "all";
  onToggle: () => void;
}) {
  return (
    <input
      type="checkbox"
      className="size-4 align-middle accent-primary"
      aria-label="Select all rows of this page"
      checked={state === "all"}
      ref={(el) => {
        if (el) el.indeterminate = state === "some";
      }}
      onChange={onToggle}
    />
  );
}

function SortIcon({ state }: { state: SortState }) {
  const Icon = state === "ascending" ? ArrowUp : state === "descending" ? ArrowDown : ArrowUpDown;
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-3", state === "none" ? "text-muted-foreground" : "text-foreground")}
    />
  );
}

function HeaderCell({
  column,
  revealed,
  onReveal,
  onHide,
  sort,
  whyNot,
  onSort,
}: {
  column: RowColumn;
  revealed: boolean;
  onReveal: (column: string) => void;
  onHide: (column: string) => void;
  sort: RowSort | null;
  /** Why this column cannot be sorted (a tooltip), or null when it can. */
  whyNot: string | null;
  onSort: (column: string) => void;
}) {
  const state = sortStateOf(sort, column.name);
  return (
    <th
      scope="col"
      aria-sort={whyNot === null ? state : undefined}
      className="px-3 py-2 align-bottom font-medium whitespace-nowrap"
    >
      <div className="flex items-center gap-1.5">
        {column.masked ? (
          <Lock className="size-3 text-muted-foreground" aria-hidden="true" />
        ) : null}
        {whyNot === null ? (
          <button
            type="button"
            onClick={() => onSort(column.name)}
            aria-label={`Sort by ${column.name}`}
            title={sortActionLabel(sort, column.name)}
            className="inline-flex items-center gap-1 rounded-sm font-mono text-xs outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {column.name}
            <SortIcon state={state} />
          </button>
        ) : (
          <span className="font-mono text-xs" title={whyNot}>
            {column.name}
          </span>
        )}
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
      <div className="font-mono text-[10px] font-normal text-foreground/70">{column.dataType}</div>
    </th>
  );
}

/**
 * An Edit or Delete button. When the row cannot be changed it stays focusable
 * (so its reason can be read) but does nothing, and says why.
 */
function RowActionButton({
  label,
  block,
  onClick,
  children,
}: {
  label: string;
  block: string | null;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tip label={block ?? label}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-disabled={block !== null}
        aria-description={block ?? undefined}
        className={cn("size-8", block !== null && "cursor-not-allowed opacity-40")}
        onClick={block === null ? onClick : undefined}
      >
        {children}
      </Button>
    </Tip>
  );
}
