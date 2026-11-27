/**
 * The full value of one cell, with a copy button. Opened from the grid. Its
 * content is kept only while the dialog fades out (so it does not collapse to
 * an empty box), then dropped.
 */
"use client";

import { useState } from "react";
import {
  ROWS_CELL_CHARS,
  type KeyValue,
  type RowCell,
  type RowColumn,
  type RowFilter,
  type TableRef,
} from "@datacanvas/database-core";
import { Braces, ListFilter, PencilLine } from "lucide-react";
import { cellRequestFor } from "@/features/json/cell-key";
import { CutTextDialog } from "@/features/writes/cut-text-dialog";
import { JsonEditorDialog } from "@/features/json/json-editor-dialog";
import { getCell } from "./api";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { filterForCell } from "./filtering";
import type { GridCellEditing } from "./data-grid";
import { BLUR_CLASSES, useBlurStore } from "./blur-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface OpenCell {
  column: RowColumn;
  cell: RowCell;
  /** The key of the cell's row, when it can be named (the Data section); lets a cut JSON value be read whole. */
  key?: KeyValue[] | null;
  /** The cell's position on the page, so an edit can be kept for it (the Data section). */
  row?: number;
  col?: number;
}

/** Where a cell of the Data section comes from, so its JSON can be read whole. */
export interface CellSource {
  connectionId: string;
  table: TableRef;
}

export function CellDialog({
  open,
  onClose,
  onFilter,
  source,
  cells,
}: {
  open: OpenCell | null;
  /** Editing cells in the grid (writes unlocked): lets a cut text value be edited whole from here. */
  cells?: GridCellEditing | null;
  onClose: () => void;
  /** The table the cell is from (the Data section; not the SQL result). */
  source?: CellSource;
  /** When given, the dialog offers "Filter by this value" (the Data section; not the SQL result). */
  onFilter?: (filter: RowFilter) => void;
}) {
  const blurred = useBlurStore((s) => s.blurred);
  const [leaving, setLeaving] = useState<OpenCell | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // Remember what was open, so the closing animation still has something to show.
  if (open && open !== leaving) setLeaving(open);
  const shown = open ?? leaving;
  // A cut text cell whose whole value can be edited from here (null: it cannot, or editing is not on).
  const cut =
    open && cells && open.row !== undefined && open.col !== undefined
      ? cells.cutText(open.row, open.col)
      : null;
  return (
    <Dialog open={open !== null} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        className="max-w-2xl"
        onAnimationEnd={(event) => {
          if (event.currentTarget.dataset.state === "closed") setLeaving(null);
        }}
      >
        {shown ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono">{shown.column.name}</DialogTitle>
              <DialogDescription>{shown.column.dataType}</DialogDescription>
            </DialogHeader>
            <pre
              tabIndex={0}
              aria-label={`Value of ${shown.column.name}`}
              className={cn(
                "max-h-[50vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap",
                blurred && BLUR_CLASSES,
              )}
            >
              {cut?.pending ? cut.pending.after : shown.cell.value}
            </pre>
            {blurred ? (
              <p role="note" className="text-sm text-muted-foreground">
                Values are blurred. Switch off “Blur values” to read this one.
              </p>
            ) : null}
            {cut?.pending ? (
              <p role="note" className="text-sm text-muted-foreground">
                This value was changed and is not saved yet. The new value is shown.
              </p>
            ) : shown.cell.truncated ? (
              <p role="note" className="text-sm text-muted-foreground">
                This value is longer than {new Intl.NumberFormat().format(ROWS_CELL_CHARS)}{" "}
                characters. Only the first {new Intl.NumberFormat().format(ROWS_CELL_CHARS)} are
                shown.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              {cut && source && shown.key && shown.row !== undefined && shown.col !== undefined ? (
                <>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
                    <PencilLine aria-hidden="true" />
                    Edit this value
                  </Button>
                  <CutTextDialog
                    open={editOpen}
                    onClose={() => setEditOpen(false)}
                    column={shown.column.name}
                    pending={cut.pending}
                    load={() =>
                      getCell(
                        source.connectionId,
                        cellRequestFor(source.table, shown.column.name, shown.key!),
                      )
                    }
                    onUse={(text, before) => {
                      cells?.onSet(shown.row!, shown.col!, text, before);
                      setEditOpen(false);
                      onClose();
                    }}
                  />
                </>
              ) : null}
              <JsonButton
                shown={shown}
                source={source}
                open={jsonOpen}
                onOpen={() => setJsonOpen(true)}
                onClose={() => setJsonOpen(false)}
              />
              {onFilter ? (
                <FilterByValue
                  open={shown}
                  onFilter={(filter) => {
                    onFilter(filter);
                    onClose();
                  }}
                />
              ) : null}
              <CopyButton
                text={shown.cell.value ?? ""}
                label={`Copy the value of ${shown.column.name}`}
              />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Open as JSON" for a JSON value: the whole document in the JSON editor, to read. A value that a page cut
 * short is read whole from the database (when its row can be named); without that there is only a piece, and
 * a piece of a document is not offered.
 */
function JsonButton({
  shown,
  source,
  open,
  onOpen,
  onClose,
}: {
  shown: OpenCell;
  source: CellSource | undefined;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { column, cell, key } = shown;
  if (column.kind !== "json" || cell.value === null) return null;
  const canLoad = cell.truncated && source !== undefined && !!key;
  if (cell.truncated && !canLoad) return null;
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={onOpen}>
        <Braces aria-hidden="true" />
        Open as JSON
      </Button>
      <JsonEditorDialog
        open={open}
        onClose={onClose}
        column={column.name}
        text={cell.value}
        load={
          canLoad
            ? () => getCell(source.connectionId, cellRequestFor(source.table, column.name, key))
            : undefined
        }
        readOnly
      />
    </>
  );
}

function FilterByValue({
  open,
  onFilter,
}: {
  open: OpenCell;
  onFilter: (filter: RowFilter) => void;
}) {
  const filter = filterForCell(open.column, open.cell.value, open.cell.truncated);
  if (!filter) return null;
  return (
    <Button type="button" size="sm" variant="ghost" onClick={() => onFilter(filter)}>
      <ListFilter aria-hidden="true" />
      Filter by this value
    </Button>
  );
}
