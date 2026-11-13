/**
 * The explorer tree for one connection: schemas, each expandable to its
 * tables and views. Tables are loaded lazily when a schema is first opened,
 * so connecting to a database with many schemas stays fast.
 *
 * What clicking does depends on the current view:
 *   canvas view  -> adds the table to the canvas and flies to it;
 *   details view -> shows the table's details.
 */
"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, LayoutGrid } from "lucide-react";
import { KIND_ICON, KIND_LABEL } from "@/components/relation-kind";
import { tableRefKey, type TableInfo } from "@datacanvas/database-core";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";
import { Button } from "@/components/ui/button";
import { addSchemaToCanvas, addTablesToCanvas } from "@/features/canvas/add-tables";
import { cn } from "@/lib/utils";
import { useAsyncData } from "@/lib/use-async-data";
import { useCanvasStore } from "@/stores/canvas-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { getSchemas, getTables } from "./api";

function TableRow({ connectionId, table }: { connectionId: string; table: TableInfo }) {
  const Icon = KIND_ICON[table.kind];
  const selected = useWorkspaceStore(
    (s) => s.selectedTable?.schema === table.schema && s.selectedTable.name === table.name,
  );
  const view = useWorkspaceStore((s) => s.view);
  const selectTable = useWorkspaceStore((s) => s.selectTable);
  const onCanvas = useCanvasStore((s) =>
    s.canvases[connectionId]?.nodes.some(
      (n) => n.id === tableRefKey({ schema: table.schema, name: table.name }),
    ),
  );

  function open() {
    const ref = { schema: table.schema, name: table.name };
    selectTable(ref);
    if (view === "canvas") void addTablesToCanvas(connectionId, [ref], { focus: true });
  }

  return (
    <li>
      <button
        type="button"
        onClick={open}
        aria-current={selected ? "true" : undefined}
        title={
          view === "canvas"
            ? `${KIND_LABEL[table.kind]}: click to add to the canvas`
            : KIND_LABEL[table.kind]
        }
        className={cn(
          "flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-6 text-left text-sm hover:bg-accent",
          selected && "bg-accent font-medium",
        )}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{table.name}</span>
        <span className="sr-only">({KIND_LABEL[table.kind]})</span>
        {onCanvas ? (
          <span
            className="ml-auto size-1.5 shrink-0 rounded-full bg-sky-500"
            title="On the canvas"
            aria-label="on the canvas"
          />
        ) : null}
      </button>
    </li>
  );
}

function TableList({ connectionId, schema }: { connectionId: string; schema: string }) {
  const { state, reload } = useAsyncData(
    () => getTables(connectionId, schema),
    `${connectionId}/${schema}`,
  );

  if (state.status === "loading") return <LoadingState label="Loading tables…" />;
  if (state.status === "error") {
    return (
      <ErrorState title="Could not load tables" message={state.error.message} onRetry={reload} />
    );
  }
  if (state.data.length === 0) {
    return <p className="px-6 py-1 text-sm text-muted-foreground">No tables in this schema.</p>;
  }

  return (
    <ul className="flex flex-col">
      {state.data.map((table) => (
        <TableRow key={table.name} connectionId={connectionId} table={table} />
      ))}
    </ul>
  );
}

function SchemaNode({
  connectionId,
  schema,
  defaultOpen,
}: {
  connectionId: string;
  schema: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const view = useWorkspaceStore((s) => s.view);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-sm font-medium hover:bg-accent"
        >
          <Chevron className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{schema}</span>
        </button>
        {view === "canvas" ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void addSchemaToCanvas(connectionId, schema)}
            aria-label={`Add all tables of ${schema} to the canvas`}
            title="Add all tables of this schema to the canvas"
          >
            <LayoutGrid aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {open ? <TableList connectionId={connectionId} schema={schema} /> : null}
    </li>
  );
}

export function SchemaTree({ connectionId }: { connectionId: string }) {
  const { state, reload } = useAsyncData(() => getSchemas(connectionId), connectionId);

  if (state.status === "loading") return <LoadingState label="Loading schemas…" />;
  if (state.status === "error") {
    return (
      <ErrorState title="Could not load schemas" message={state.error.message} onRetry={reload} />
    );
  }
  if (state.data.length === 0) {
    return <p className="text-sm text-muted-foreground">This database has no schemas.</p>;
  }

  // Open "public" by default (the usual home of application tables), else the first schema.
  const defaultOpenName = state.data.some((s) => s.name === "public")
    ? "public"
    : state.data[0]?.name;
  return (
    <ul className="flex flex-col gap-1" aria-label="Schemas">
      {state.data.map((schema) => (
        <SchemaNode
          key={schema.name}
          connectionId={connectionId}
          schema={schema.name}
          defaultOpen={schema.name === defaultOpenName}
        />
      ))}
    </ul>
  );
}
