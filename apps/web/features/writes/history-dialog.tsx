/**
 * The changes made since connecting (decision 131): the operation, the table,
 * the column names, the time and the outcome, and the SQL of a change of
 * structure. Never a value. Kept in server memory; this dialog only shows it.
 */
"use client";

import { useEffect } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConnectionWrites, useWritesStore } from "@/stores/writes-store";
import { changeLabel } from "./structure";

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

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Changes in this session</DialogTitle>
          <DialogDescription>
            What was changed on {connectionName} since you connected: names only, never values. Kept
            in memory and gone when you disconnect.
          </DialogDescription>
        </DialogHeader>
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
