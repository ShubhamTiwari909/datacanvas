/**
 * "Export diagram" dialog. It states what the image will contain BEFORE it is
 * created, because table and column names can themselves be sensitive.
 */
"use client";

import { Download, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ImageFormat } from "./export-image";

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExport: (format: ImageFormat) => void;
  /** Opens the documentation export (Markdown, Mermaid, DBML, PlantUML). */
  onDocumentation: () => void;
  exporting: ImageFormat | null;
  error: string | null;
  tableCount: number;
}

export function ExportDialog({
  open,
  onOpenChange,
  onExport,
  onDocumentation,
  exporting,
  error,
  tableCount,
}: ExportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Export diagram</DialogTitle>
          <DialogDescription>
            Saves the {tableCount} visible table{tableCount === 1 ? "" : "s"} and their
            relationships as an image.
          </DialogDescription>
        </DialogHeader>

        <div
          role="note"
          className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            The image shows <strong>table and column names</strong>, which can reveal how your
            system works. Share it only with people who are meant to see that. It contains no row
            data, and nothing is uploaded: the file is created and saved on this computer.
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter className="sm:flex-wrap">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={onDocumentation}>
            Documentation and diagram text…
          </Button>
          <Button variant="outline" disabled={exporting !== null} onClick={() => onExport("svg")}>
            {exporting === "svg" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Download aria-hidden="true" />
            )}
            Save as SVG
          </Button>
          <Button disabled={exporting !== null} onClick={() => onExport("png")}>
            {exporting === "png" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Download aria-hidden="true" />
            )}
            Save as PNG
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
