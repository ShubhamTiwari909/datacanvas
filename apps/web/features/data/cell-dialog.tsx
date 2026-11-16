/** The full value of one cell, with a copy button. Opened from the grid; holds nothing after it closes. */
"use client";

import { ROWS_CELL_CHARS, type RowCell, type RowColumn } from "@datacanvas/database-core";
import { CopyButton } from "@/components/copy-button";
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
}

export function CellDialog({ open, onClose }: { open: OpenCell | null; onClose: () => void }) {
  return (
    <Dialog open={open !== null} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-2xl">
        {open ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono">{open.column.name}</DialogTitle>
              <DialogDescription>{open.column.dataType}</DialogDescription>
            </DialogHeader>
            <pre
              tabIndex={0}
              aria-label={`Value of ${open.column.name}`}
              className="max-h-[50vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap"
            >
              {open.cell.value}
            </pre>
            {open.cell.truncated ? (
              <p role="note" className="text-sm text-muted-foreground">
                This value is longer than {new Intl.NumberFormat().format(ROWS_CELL_CHARS)}{" "}
                characters. Only the first {new Intl.NumberFormat().format(ROWS_CELL_CHARS)} are
                shown.
              </p>
            ) : null}
            <div className="flex justify-end">
              <CopyButton
                text={open.cell.value ?? ""}
                label={`Copy the value of ${open.column.name}`}
              />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
