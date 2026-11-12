/**
 * The explorer tree for one connection: schemas, each expandable to its
 * tables and views. Tables are loaded lazily when a schema is first opened,
 * so connecting to a database with many schemas stays fast.
 */
"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, Layers, Table2 } from "lucide-react";
import type { RelationKind, TableInfo } from "@datacanvas/database-core";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";
import { cn } from "@/lib/utils";
import { useAsyncData } from "@/lib/use-async-data";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { getSchemas, getTables } from "./api";

const KIND_ICON: Record<RelationKind, typeof Table2> = {
  table: Table2,
  view: Eye,
  materialized_view: Layers,
};
const KIND_LABEL: Record<RelationKind, string> = {
  table: "Table",
  view: "View",
  materialized_view: "Materialized view",
};

function TableList({ connectionId, schema }: { connectionId: string; schema: string }) {
  const { state, reload } = useAsyncData(
    () => getTables(connectionId, schema),
    `${connectionId}/${schema}`,
  );
  const selected = useWorkspaceStore((s) => s.selectedTable);
  const selectTable = useWorkspaceStore((s) => s.selectTable);

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
      {state.data.map((table: TableInfo) => {
        const Icon = KIND_ICON[table.kind];
        const isSelected = selected?.schema === table.schema && selected.name === table.name;
        return (
          <li key={table.name}>
            <button
              type="button"
              onClick={() => selectTable({ schema: table.schema, name: table.name })}
              aria-current={isSelected ? "true" : undefined}
              title={KIND_LABEL[table.kind]}
              className={cn(
                "flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-6 text-left text-sm hover:bg-accent",
                isSelected && "bg-accent font-medium",
              )}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{table.name}</span>
              <span className="sr-only">({KIND_LABEL[table.kind]})</span>
            </button>
          </li>
        );
      })}
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
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-sm font-medium hover:bg-accent"
      >
        <Chevron className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{schema}</span>
      </button>
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
