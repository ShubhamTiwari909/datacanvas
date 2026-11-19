/**
 * The statements run on this connection since the page was opened (decision 141): newest first,
 * with how each went. Held in memory only; this dialog shows it, and can open a statement in a
 * new tab, run it again, copy it, or clear the list.
 */
"use client";

import { useState } from "react";
import { Ban, CheckCircle2, Play, SquarePlus, XCircle } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { HistoryEntry } from "@/stores/sql-store";
import { durationText, rowsText } from "./result-text";

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

/** The entries whose statement holds the words typed (all of them, any case), newest first as given. */
export function filterHistory(history: readonly HistoryEntry[], query: string): HistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...history];
  return history.filter((h) => {
    const text = h.text.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export function HistoryDialog(props: {
  open: boolean;
  onClose: () => void;
  history: readonly HistoryEntry[];
  /** Another statement may be run now (none is running). */
  canRun: boolean;
  /** Open the statement in a new tab, and run it when `run` is set. */
  onOpen: (entry: HistoryEntry, run: boolean) => void;
  onClear: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(isOpen) => !isOpen && props.onClose()}>
      <DialogContent size="builder">
        {/* The body is made when the dialog opens, so a search typed last time is gone. */}
        <HistoryBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

function HistoryBody({
  history,
  canRun,
  onOpen,
  onClear,
}: {
  history: readonly HistoryEntry[];
  canRun: boolean;
  onOpen: (entry: HistoryEntry, run: boolean) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = filterHistory(history, query);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Query history</DialogTitle>
        <DialogDescription>
          What was run on this connection since you opened this page. Kept in memory only, and gone
          when you close the page or disconnect.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2">
        <Input
          type="search"
          aria-label="Search the history"
          placeholder="Search the statements"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="button" variant="outline" disabled={history.length === 0} onClick={onClear}>
          Clear history
        </Button>
      </div>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing was run yet.</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No statement matches.</p>
      ) : (
        <ol aria-label="Statements" className="flex flex-col gap-2 pb-6">
          {shown.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {entry.outcome === "ok" ? (
                  <CheckCircle2
                    className="size-4 text-emerald-600 dark:text-emerald-400"
                    aria-label="ran"
                  />
                ) : entry.outcome === "cancelled" ? (
                  <Ban className="size-4" aria-label="cancelled" />
                ) : (
                  <XCircle className="size-4 text-destructive" aria-label="failed" />
                )}
                <time dateTime={new Date(entry.at).toISOString()}>
                  {timeFormat.format(entry.at)}
                </time>
                <span>{durationText(entry.elapsedMs)}</span>
                <span>
                  {entry.outcome === "ok" && entry.rows !== null
                    ? rowsText(entry.rows)
                    : entry.outcome === "cancelled"
                      ? "cancelled"
                      : entry.code}
                </span>
                <span className="ml-auto truncate">{entry.tabName}</span>
              </div>
              <pre className="max-h-24 overflow-auto rounded-md bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">
                {entry.text}
              </pre>
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onOpen(entry, false)}
                >
                  <SquarePlus aria-hidden="true" />
                  Open in a new tab
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canRun}
                  onClick={() => onOpen(entry, true)}
                >
                  <Play aria-hidden="true" />
                  Run again
                </Button>
                <CopyButton text={entry.text} label="Copy statement" />
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
