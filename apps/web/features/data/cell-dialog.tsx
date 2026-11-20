/**
 * The full value of one cell, with a copy button. Opened from the grid. Its
 * content is kept only while the dialog fades out (so it does not collapse to
 * an empty box), then dropped.
 */
"use client";

import { useState } from "react";
import {
  ROWS_CELL_CHARS,
  type RowCell,
  type RowColumn,
  type RowFilter,
} from "@datacanvas/database-core";
import { ListFilter } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { filterForCell } from "./filtering";
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
}

export function CellDialog({
  open,
  onClose,
  onFilter,
}: {
  open: OpenCell | null;
  onClose: () => void;
  /** When given, the dialog offers "Filter by this value" (the Data section; not the SQL result). */
  onFilter?: (filter: RowFilter) => void;
}) {
  const blurred = useBlurStore((s) => s.blurred);
  const [leaving, setLeaving] = useState<OpenCell | null>(null);
  // Remember what was open, so the closing animation still has something to show.
  if (open && open !== leaving) setLeaving(open);
  const shown = open ?? leaving;
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
              {shown.cell.value}
            </pre>
            {blurred ? (
              <p role="note" className="text-sm text-muted-foreground">
                Values are blurred. Switch off “Blur values” to read this one.
              </p>
            ) : null}
            {shown.cell.truncated ? (
              <p role="note" className="text-sm text-muted-foreground">
                This value is longer than {new Intl.NumberFormat().format(ROWS_CELL_CHARS)}{" "}
                characters. Only the first {new Intl.NumberFormat().format(ROWS_CELL_CHARS)} are
                shown.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
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
