/**
 * The SQL view (1.6.0, decisions 141 and 142): an editor above, the result below. One
 * statement is run at a time, read-only, with a limit on rows and time. A refused statement
 * is shown with the database's own sentence and marked in the text.
 *
 * It needs viewing table data to be on for the connection (a result is rows); until then it
 * says so and offers to switch it on.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, Database, Play, Square } from "lucide-react";
import { EmptyState } from "@/components/states/empty-state";
import { LoadingState } from "@/components/states/loading-state";
import { Button } from "@/components/ui/button";
import { useConnectionSql, useSqlStore } from "@/stores/sql-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { ResultGrid } from "./result-grid";
import { elapsedText, failureTitle, lineColumn, resultSummary, ROW_LIMITS } from "./result-text";

// Monaco is big: it is fetched when this view opens, never with the first page.
const SqlEditor = dynamic(() => import("./sql-editor"), {
  ssr: false,
  loading: () => <LoadingState label="Loading the editor…" />,
});

export function SqlView({ connectionId }: { connectionId: string }) {
  const connection = useWorkspaceStore((s) => s.connections.find((c) => c.id === connectionId));
  const setDataAccess = useWorkspaceStore((s) => s.setDataAccess);

  if (!connection) return null;
  if (!connection.dataAccess) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <EmptyState
          icon={Database}
          title="Table data is switched off"
          description="Running SQL shows rows, so it needs viewing table data to be on for this connection."
        >
          <Button type="button" onClick={() => void setDataAccess(connectionId, true)}>
            Switch on table data
          </Button>
        </EmptyState>
      </div>
    );
  }
  return <Editor connectionId={connectionId} />;
}

function Editor({ connectionId }: { connectionId: string }) {
  const { text, maxRows, state } = useConnectionSql(connectionId);
  const setText = useSqlStore((s) => s.setText);
  const setMaxRows = useSqlStore((s) => s.setMaxRows);
  const run = useSqlStore((s) => s.run);
  const cancel = useSqlStore((s) => s.cancel);
  const running = state.kind === "running";

  // The text the editor starts with is the one kept for this connection.
  const [initialText] = useState(text);

  // The database's position means something only while the text is as it was when it ran.
  const failureOffset =
    state.kind === "failure" && state.failure.position !== null && state.docText === text
      ? state.base + state.failure.position
      : null;
  const failureMessage = state.kind === "failure" ? state.failure.message : "";
  const marker = useMemo(
    () => (failureOffset === null ? null : { offset: failureOffset, message: failureMessage }),
    [failureOffset, failureMessage],
  );

  return (
    <div className="flex h-full min-h-[28rem] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button
          type="button"
          size="sm"
          disabled={running}
          onClick={() => void run(connectionId, text, 0)}
        >
          <Play aria-hidden="true" />
          Run
        </Button>
        {running ? (
          <Button type="button" size="sm" variant="outline" onClick={() => cancel(connectionId)}>
            <Square aria-hidden="true" />
            Cancel
          </Button>
        ) : null}
        <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          Row limit
          <select
            aria-label="Row limit"
            value={maxRows}
            disabled={running}
            onChange={(event) => setMaxRows(connectionId, Number(event.target.value))}
            className="h-7 rounded-md border bg-background px-1.5 text-xs text-foreground"
          >
            {ROW_LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {new Intl.NumberFormat("en").format(limit)}
              </option>
            ))}
          </select>
        </label>
        <p className="ml-auto text-xs text-muted-foreground">
          Read-only. <kbd className="font-mono">Ctrl</kbd>/<kbd className="font-mono">⌘</kbd>{" "}
          <kbd className="font-mono">Enter</kbd> runs the selection, or everything. Press{" "}
          <kbd className="font-mono">Esc</kbd> then <kbd className="font-mono">Tab</kbd> to leave
          the editor.
        </p>
      </div>
      <div className="h-[40%] min-h-40 border-b">
        <SqlEditor
          initialValue={initialText}
          onChange={(value) => setText(connectionId, value)}
          onRun={(runText, base) => void run(connectionId, runText, base)}
          marker={marker}
        />
      </div>
      <section aria-label="Result" className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <Result connectionId={connectionId} />
      </section>
    </div>
  );
}

function Result({ connectionId }: { connectionId: string }) {
  const { state } = useConnectionSql(connectionId);

  if (state.kind === "idle") {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Type a statement above and run it. Only SELECT, WITH, VALUES, TABLE, EXPLAIN and SHOW are
        accepted, and nothing is changed.
      </p>
    );
  }
  if (state.kind === "running") return <Running startedAt={state.startedAt} />;
  if (state.kind === "cancelled") {
    return (
      <div role="status" className="p-4 text-sm text-muted-foreground">
        The statement was cancelled.
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <p>{state.message}</p>
      </div>
    );
  }
  if (state.kind === "failure") {
    const { failure, ranText } = state;
    const where = failure.position !== null ? lineColumn(ranText, failure.position) : null;
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium">{failureTitle(failure)}</p>
          <p className="mt-1 font-mono text-xs break-words whitespace-pre-wrap">
            {failure.message}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {failure.code}
            {where ? ` · line ${where.line}, column ${where.column}` : ""}
          </p>
        </div>
      </div>
    );
  }
  const { result } = state;
  if (result.columns.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        The statement ran and returned no columns. {resultSummary(result).at(-1)}.
      </p>
    );
  }
  return (
    <>
      <div className="min-h-0 flex-1">
        {result.rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No rows. Columns:{" "}
            <span className="font-mono">{result.columns.map((c) => c.name).join(", ")}</span>
          </p>
        ) : (
          <ResultGrid result={result} />
        )}
      </div>
      <p className="text-xs text-muted-foreground">{resultSummary(result).join(" · ")}</p>
    </>
  );
}

function Running({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <div role="status" className="p-4 text-sm text-muted-foreground">
      Running… {elapsedText(elapsed)}
    </div>
  );
}
