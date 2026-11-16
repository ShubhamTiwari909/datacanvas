/**
 * The full value of one cell, with a copy button. Opened from the grid. Its
 * content is kept only while the dialog fades out (so it does not collapse to
 * an empty box), then dropped.
 */
"use client";

import { useState } from "react";
import { ROWS_CELL_CHARS, type RowCell, type RowColumn } from "@datacanvas/database-core";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
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

export function CellDialog({ open, onClose }: { open: OpenCell | null; onClose: () => void }) {
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
            <div className="flex justify-end">
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
