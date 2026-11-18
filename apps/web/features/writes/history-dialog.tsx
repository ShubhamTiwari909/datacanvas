/**
 * The changes made since connecting (decision 131): the operation, the table,
 * the column names, the time and the outcome, and the SQL of a change of
 * structure. Never a value. Kept in server memory; this dialog only shows it.
 */
"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Download, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConnectionWrites, useWritesStore } from "@/stores/writes-store";
import { getWritesMigration } from "./api";
import { changeLabel } from "./structure";

/** A row change is data, not structure: it is not part of a migration file. */
const ROW_KINDS = new Set(["update_row", "insert_row", "delete_row"]);

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : timeFormat.format(date);
}

export function HistoryDialog({
  connectionId,
  connectionName,
  open,
  onClose,
}: {
  connectionId: string;
  connectionName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { history } = useConnectionWrites(connectionId);
  const loadHistory = useWritesStore((s) => s.loadHistory);

  useEffect(() => {
    if (open) void loadHistory(connectionId);
  }, [open, connectionId, loadHistory]);

  const newestFirst = [...history].reverse();
  const structureApplied = history.some(
    (entry) => entry.outcome === "applied" && !ROW_KINDS.has(entry.kind),
  );
  const [exportError, setExportError] = useState<string | null>(null);

  async function exportMigration() {
    setExportError(null);
    const result = await getWritesMigration(connectionId);
    if (!result.ok) {
      setExportError("The migration could not be made. Try again.");
      return;
    }
    // A download made in the browser from text already in hand: nothing is stored.
    const url = URL.createObjectURL(new Blob([result.data.script], { type: "application/sql" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = result.data.filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Changes in this session</DialogTitle>
          <DialogDescription>
            What was changed on {connectionName} since you connected: names only, never values. Kept
            in memory and gone when you disconnect.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!structureApplied}
            onClick={() => void exportMigration()}
          >
            <Download aria-hidden />
            Export migration (.sql)
          </Button>
          <p className="text-xs text-muted-foreground">
            The changes of structure as one SQL script. Row changes are left out.
          </p>
        </div>
        {exportError ? (
          <p role="alert" className="text-xs text-destructive">
            {exportError}
          </p>
        ) : null}
        {newestFirst.length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes yet.</p>
        ) : (
          <ol aria-label="Changes" className="flex flex-col gap-2">
            {newestFirst.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {entry.outcome === "applied" ? (
                    <CheckCircle2
                      className="size-4 text-emerald-600 dark:text-emerald-400"
                      aria-label="applied"
                    />
                  ) : (
                    <XCircle className="size-4 text-destructive" aria-label="failed" />
                  )}
                  <span className="font-medium">{changeLabel(entry.kind)}</span>
                  <span className="font-mono text-xs">
                    {entry.table.schema}.{entry.table.name}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    <time dateTime={entry.at}>{formatTime(entry.at)}</time>
                  </span>
                </div>
                {entry.columns.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Columns: <span className="font-mono">{entry.columns.join(", ")}</span>
                  </p>
                ) : null}
                {entry.outcome === "failed" ? (
                  <p className="text-xs text-destructive">
                    Not applied
                    {entry.errorCode ? <Badge variant="outline">{entry.errorCode}</Badge> : null}
                  </p>
                ) : null}
                {entry.statement ? (
                  <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">
                    {entry.statement}
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
