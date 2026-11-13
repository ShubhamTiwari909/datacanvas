/**
 * The "Paths" tab: pick two tables and see how they are connected.
 *
 * It follows declared foreign keys only. For each shortest route it shows the
 * chain of tables and the columns joined at each step, the SQL for the join
 * (text to copy, never run) and a button that puts the tables on the canvas.
 */
"use client";

import { useState } from "react";
import { ArrowDown, ArrowLeftRight, Layers, Route } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { addTablesToCanvas } from "@/features/canvas/add-tables";
import { useAsyncData } from "@/lib/use-async-data";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { loadPathData, type PathData } from "./load-path-data";
import { buildJoinSql, findPaths, type FoundPath, type TableKey } from "./path-finder";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const label = (t: TableKey): string => `${t.schema}.${t.table}`;

function TableSelect({
  id,
  text,
  tables,
  value,
  onChange,
}: {
  id: string;
  text: string;
  tables: TableKey[];
  value: number | null;
  onChange: (index: number | null) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {text}
      </label>
      <select
        id={id}
        value={value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm"
      >
        <option value="">Choose a table…</option>
        {tables.map((t, i) => (
          <option key={label(t)} value={i}>
            {label(t)}
          </option>
        ))}
      </select>
    </div>
  );
}

function PathCard({
  path,
  index,
  total,
  onShow,
}: {
  path: FoundPath;
  index: number;
  total: number;
  onShow: (tables: TableKey[]) => void;
}) {
  const sql = buildJoinSql(path);
  return (
    <article
      aria-label={total > 1 ? `Route ${index + 1} of ${total}` : "Route"}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {total > 1 ? `Route ${index + 1}` : "Route"}
          <span className="ml-2 font-normal text-muted-foreground">
            {plural(path.steps.length, "join")}
          </span>
        </h3>
        <Button type="button" size="sm" variant="outline" onClick={() => onShow(path.tables)}>
          <Layers aria-hidden="true" />
          Show on canvas
        </Button>
      </header>

      <ol className="flex flex-col gap-1 text-sm">
        {path.tables.map((table, i) => {
          const step = path.steps[i];
          return (
            <li key={`${label(table)}-${i}`} className="flex flex-col gap-1">
              <span className="font-mono">{label(table)}</span>
              {step ? (
                <span className="flex flex-wrap items-center gap-2 pl-2 text-xs text-muted-foreground">
                  <ArrowDown className="size-3.5" aria-hidden="true" />
                  <code>
                    {step.fromColumns.join(", ")} = {step.toColumns.join(", ")}
                  </code>
                  <Badge variant="outline">
                    {step.direction === "references" ? "at most one row" : "can match many rows"}
                  </Badge>
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      {path.multipliesRows ? (
        <p className="text-xs text-muted-foreground">
          This route goes from a parent to the rows that reference it, so one starting row can
          appear several times in the result.
        </p>
      ) : null}

      <div className="flex items-start justify-between gap-2 rounded-md bg-muted p-2">
        <pre className="min-w-0 overflow-x-auto text-xs">
          <code>{sql}</code>
        </pre>
        <CopyButton text={sql} />
      </div>
    </article>
  );
}

function Finder({ connectionId, data }: { connectionId: string; data: PathData }) {
  const setView = useWorkspaceStore((s) => s.setView);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);

  const fromTable = from === null ? undefined : data.tables[from];
  const toTable = to === null ? undefined : data.tables[to];
  const result = fromTable && toTable ? findPaths(data.relationships, fromTable, toTable) : null;

  const show = (tables: TableKey[]): void => {
    void addTablesToCanvas(
      connectionId,
      tables.map((t) => ({ schema: t.schema, name: t.table })),
      { focus: true },
    ).then((ok) => {
      if (ok) setView("canvas");
    });
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 p-4">
      <header className="flex flex-col gap-1">
        <h2 className="flex flex-wrap items-baseline gap-x-3 text-lg font-semibold">
          Paths
          <span className="text-sm font-normal text-muted-foreground">
            How are two tables connected? Only declared foreign keys are followed.
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">
          The SQL is for you to copy and review. DataCanvas does not run it.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <TableSelect
          id="path-from"
          text="From table"
          tables={data.tables}
          value={from}
          onChange={setFrom}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Swap the two tables"
          onClick={() => {
            setFrom(to);
            setTo(from);
          }}
        >
          <ArrowLeftRight aria-hidden="true" />
        </Button>
        <TableSelect
          id="path-to"
          text="To table"
          tables={data.tables}
          value={to}
          onChange={setTo}
        />
      </div>

      {data.tables.length === 0 ? (
        <p className="text-sm text-muted-foreground">This database has no tables.</p>
      ) : data.relationships.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This database declares no foreign keys, so there are no routes to find.
        </p>
      ) : null}

      {!result ? (
        <EmptyState
          icon={Route}
          title="Pick two tables"
          description="DataCanvas will find the shortest chain of relationships between them and write the join."
        />
      ) : result.status === "same_table" ? (
        <p role="status" className="text-sm">
          These are the same table. Pick two different tables.
        </p>
      ) : result.status === "none" ? (
        <p role="status" className="text-sm">
          No route: no chain of declared foreign keys connects{" "}
          <span className="font-mono">{label(fromTable as TableKey)}</span> and{" "}
          <span className="font-mono">{label(toTable as TableKey)}</span>. They may be joinable on
          columns without a declared constraint, which DataCanvas does not guess.
        </p>
      ) : (
        <>
          <p role="status" className="text-sm">
            Shortest route: {plural(result.length, "join")}
            {result.paths.length > 1 ? `, ${result.paths.length} equally short routes` : ""}
            {result.truncated ? " (more exist; the first ones are shown)" : ""}.
          </p>
          <div className="flex flex-col gap-4">
            {result.paths.map((path, i) => (
              <PathCard
                key={path.steps.map((s) => s.relationship.name).join(">")}
                path={path}
                index={i}
                total={result.paths.length}
                onShow={show}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function PathView({ connectionId }: { connectionId: string }) {
  const { state, reload } = useAsyncData(() => loadPathData(connectionId), connectionId);
  if (state.status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <LoadingState label="Reading the relationships…" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <ErrorState
          title="Could not load the relationships"
          message={state.error.message}
          onRetry={reload}
        />
      </div>
    );
  }
  return <Finder connectionId={connectionId} data={state.data} />;
}
