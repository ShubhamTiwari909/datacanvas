/**
 * The explorer tree for one connection: schemas, each expandable to its
 * tables and views. Tables are loaded lazily when a schema is first opened,
 * so connecting to a database with many schemas stays fast.
 *
 * What clicking does depends on the current view:
 *   canvas view  -> adds the table to the canvas and flies to it;
 *   details view -> shows the table's details.
 *
 * A search box above the tree narrows it to the tables and views whose name
 * contains the text. The first time it is used, every schema's table list is
 * loaded once (decision 136); the text itself never leaves the browser.
 */
"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, LayoutGrid, Plus, Search, X } from "lucide-react";
import { KIND_ICON, KIND_LABEL } from "@/components/relation-kind";
import { tableRefKey, type TableInfo } from "@datacanvas/database-core";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addSchemaToCanvas, addTablesToCanvas } from "@/features/canvas/add-tables";
import { cn } from "@/lib/utils";
import { useAsyncData } from "@/lib/use-async-data";
import { useCanvasStore } from "@/stores/canvas-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useConnectionWrites, useStructureVersion, writesReady } from "@/stores/writes-store";
import { CreateTableDialog } from "@/features/writes/create-table-dialog";
import { getSchemas, getTables } from "./api";
import { loadAllTables, type SchemaTables } from "./load-all-tables";
import { filterSchemaTables, splitMatch } from "./table-filter";

/** The name, with the part that matches the search marked (built from text, never markup). */
function TableName({ name, query }: { name: string; query?: string }) {
  const parts = query ? splitMatch(name, query) : null;
  if (!parts) return <span className="truncate">{name}</span>;
  return (
    <span className="truncate">
      {parts.before}
      <mark className="rounded-sm bg-amber-200 text-foreground dark:bg-amber-500/40">
        {parts.match}
      </mark>
      {parts.after}
    </span>
  );
}

function TableRow({
  connectionId,
  table,
  query,
}: {
  connectionId: string;
  table: TableInfo;
  /** The search text, when this row is a search result. */
  query?: string;
}) {
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
        <TableName name={table.name} query={query} />
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
  // Read again after a change of structure made here (a new, renamed or dropped table).
  const structureVersion = useStructureVersion(connectionId);
  const { state, reload } = useAsyncData(
    () => getTables(connectionId, schema),
    `${connectionId}/${schema}/${structureVersion}`,
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
  onNewTable,
}: {
  connectionId: string;
  schema: string;
  defaultOpen: boolean;
  /** Offered while writes are unlocked for the connection (1.4.0). */
  onNewTable: ((schema: string) => void) | null;
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
        {onNewTable ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onNewTable(schema)}
            aria-label={`New table in ${schema}`}
            title="Create a new table in this schema"
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {open ? <TableList connectionId={connectionId} schema={schema} /> : null}
    </li>
  );
}

function TableSearchResults({
  connectionId,
  query,
  lists,
}: {
  connectionId: string;
  query: string;
  lists: SchemaTables[];
}) {
  const result = filterSchemaTables(lists, query);
  return (
    <div className="flex flex-col gap-1">
      <p role="status" aria-live="polite" className="px-1 text-xs text-muted-foreground">
        {result.matched === 0
          ? "No table matches this text."
          : `${result.matched} of ${result.total} ${result.total === 1 ? "table" : "tables and views"}`}
      </p>
      {result.matched > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Tables that match">
          {result.schemas.map(({ schema, tables }) => (
            <li key={schema}>
              <div className="flex items-center gap-1 px-1 py-1 text-sm font-medium">
                <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{schema}</span>
              </div>
              <ul className="flex flex-col" aria-label={`Matches in ${schema}`}>
                {tables.map((table) => (
                  <TableRow
                    key={table.name}
                    connectionId={connectionId}
                    table={table}
                    query={query}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TableSearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <label htmlFor="sidebar-table-search" className="sr-only">
        Find a table
      </label>
      <Search
        className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        id="sidebar-table-search"
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="Find a table"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value !== "") {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
        className="h-7 pr-7 pl-7"
      />
      {value !== "" ? (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onChange("")}
          aria-label="Clear the table search"
          className="absolute top-1/2 right-0.5 -translate-y-1/2"
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

export function SchemaTree({ connectionId }: { connectionId: string }) {
  const { state, reload } = useAsyncData(() => getSchemas(connectionId), connectionId);
  const [query, setQuery] = useState("");
  // Every schema's table list is loaded the first time the box is used, then
  // kept for this tree (the tree is remounted for another connection). A change
  // of structure made from DataCanvas reads the lists again.
  const [searchUsed, setSearchUsed] = useState(false);
  const structureVersion = useStructureVersion(connectionId);
  const all = useAsyncData<SchemaTables[] | null>(
    () => (searchUsed ? loadAllTables(connectionId) : Promise.resolve({ ok: true, data: null })),
    `${connectionId}/${searchUsed ? "all" : "none"}/${structureVersion}`,
  );
  const searching = query.trim() !== "";
  const writes = useConnectionWrites(connectionId);
  const [newTableIn, setNewTableIn] = useState<string | null>(null);
  const onNewTable = writesReady(writes.status) ? setNewTableIn : null;

  function changeQuery(next: string) {
    setQuery(next);
    if (next.trim() !== "") setSearchUsed(true);
  }

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

  let results: ReactNode = null;
  if (searching) {
    if (all.state.status === "error") {
      results = (
        <ErrorState
          title="Could not load the table lists"
          message={all.state.error.message}
          onRetry={all.reload}
        />
      );
    } else if (all.state.status === "success" && all.state.data) {
      results = (
        <TableSearchResults connectionId={connectionId} query={query} lists={all.state.data} />
      );
    } else {
      results = <LoadingState label="Loading tables…" />;
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="sticky top-0 z-10 bg-sidebar pb-1">
        <TableSearchBox value={query} onChange={changeQuery} />
      </div>
      {results}
      {/* Hidden, not unmounted, while searching: clearing the box brings the tree back as it was. */}
      <ul className="flex flex-col gap-1" aria-label="Schemas" hidden={searching}>
        {state.data.map((schema) => (
          <SchemaNode
            key={schema.name}
            connectionId={connectionId}
            schema={schema.name}
            defaultOpen={schema.name === defaultOpenName}
            onNewTable={onNewTable}
          />
        ))}
      </ul>
      <CreateTableDialog
        connectionId={connectionId}
        schema={onNewTable ? newTableIn : null}
        onClose={() => setNewTableIn(null)}
      />
    </div>
  );
}
