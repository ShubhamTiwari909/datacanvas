/**
 * The review of the cells edited in the grid (`docs/write-side-v2-plan.md`, section 5): every pending change, row by
 * row and a page at a time, as it was and as it will be, each one can be taken back; then the usual preview. Nothing
 * is sent until "Preview", and then only through the preview step.
 */
"use client";

import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { TableRef } from "@datacanvas/database-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import { BLUR_CLASSES, useBlurStore } from "@/features/data/blur-store";
import { describeCell } from "@/features/data/cell-text";
import { cn } from "@/lib/utils";
import { countPending, keyLabel, pendingText, type PendingState } from "./pending-cells";

/** Rows of the review on one page. */
export const REVIEW_PAGE_ROWS = 10;

export function EditCellsDialog({
  open,
  table,
  pending,
  onClose,
  onRevert,
  onPreview,
}: {
  open: boolean;
  table: TableRef;
  pending: PendingState;
  onClose: () => void;
  onRevert: (signature: string, column: string) => void;
  onPreview: () => void;
}) {
  const blurred = useBlurStore((s) => s.blurred);
  const [wanted, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(pending.rows.length / REVIEW_PAGE_ROWS));
  // Taking the last rows of the last page back moves to the page before.
  const page = Math.min(wanted, pages - 1);
  const first = page * REVIEW_PAGE_ROWS;
  const rows = pending.rows.slice(first, first + REVIEW_PAGE_ROWS);
  const counts = countPending(pending);
  const previewButton = useRef<HTMLButtonElement>(null);

  const value = (text: string | null) => {
    // The grid's own rules: NULL and the empty string apart, one line, a long value cut with a marker.
    const shown = describeCell({ value: text, truncated: false }, false);
    return shown.kind === "value" ? (
      <span className={cn(blurred && BLUR_CLASSES)}>
        {shown.text}
        {shown.clipped ? (
          <span className="text-muted-foreground" aria-label="(value cut)">
            …
          </span>
        ) : null}
      </span>
    ) : (
      <span className="text-muted-foreground italic">{shown.text}</span>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="form"
        // Focus starts on Preview, not on the first "take back" button, so Enter never takes a change back by surprise.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          previewButton.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            Review the changed cells of {table.schema}.{table.name}
          </DialogTitle>
          <DialogDescription>
            Nothing has been written yet. Each row is changed only if its cells still hold the
            values you saw (Before); a row that changed since is left out.
          </DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            No cells are changed.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Changed cells, row by row</caption>
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Row
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Column
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Before
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    After
                  </th>
                  <th scope="col" className="w-0 px-1 py-2">
                    <span className="sr-only">Take back</span>
                  </th>
                </tr>
              </thead>
              {rows.map((row) => {
                const label = keyLabel(row.key);
                return (
                  <tbody key={row.signature} className="border-t">
                    {row.cells.map((cell, i) => (
                      <tr key={cell.column} className="align-top">
                        {i === 0 ? (
                          <th
                            scope="rowgroup"
                            rowSpan={row.cells.length}
                            className="max-w-40 px-3 py-1.5 font-mono text-xs font-medium break-words"
                          >
                            {label}
                          </th>
                        ) : null}
                        <td className="px-3 py-1.5 font-mono text-xs">{cell.column}</td>
                        <td className="max-w-48 truncate px-3 py-1.5 font-mono text-xs">
                          {value(cell.before)}
                        </td>
                        <td className="max-w-48 truncate px-3 py-1.5 font-mono text-xs">
                          {value(cell.after)}
                        </td>
                        <td className="px-1 py-0.5">
                          <Tip label="Take this change back">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label={`Take back the change to ${cell.column} in ${label}`}
                              onClick={() => onRevert(row.signature, cell.column)}
                            >
                              <X aria-hidden="true" />
                            </Button>
                          </Tip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                );
              })}
            </table>
          </div>
        )}

        {pages > 1 ? (
          <div role="group" aria-label="Pages of the review" className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft aria-hidden="true" />
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= pages - 1}
              onClick={() => setPage(page + 1)}
            >
              Next
              <ChevronRight aria-hidden="true" />
            </Button>
            <span role="status" className="text-sm text-muted-foreground">
              Rows {first + 1} to {first + rows.length} of {pending.rows.length}
            </span>
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            ref={previewButton}
            type="button"
            disabled={counts.cells === 0}
            onClick={onPreview}
          >
            Preview
          </Button>
          <p
            role="status"
            className="self-center text-xs text-muted-foreground sm:order-first sm:mr-auto"
          >
            {counts.cells === 0 ? null : pendingText(counts)}
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
