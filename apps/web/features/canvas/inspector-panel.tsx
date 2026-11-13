/**
 * The inspector: a side panel describing the selected table (or tables). It
 * reads only from the metadata cache that the canvas already loaded, so
 * selecting a table never costs a request.
 *
 * Statistics are the row-count ESTIMATE the database keeps (never a count of
 * the rows themselves) plus counts of columns, constraints and indexes.
 */
"use client";

import { nodeIdFor } from "@datacanvas/canvas-engine";
import type { RelationshipInfo, TableDetailsEntry } from "@datacanvas/database-core";
import { Eye, KeyRound, Layers, Link2, PanelRightClose, Plus, Table2 } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCanvasStore } from "@/stores/canvas-store";
import { useCanvasViewStore, viewOf } from "@/stores/canvas-view-store";
import { useMetadataStore } from "@/stores/metadata-store";
import { addTablesToCanvas } from "./add-tables";

const KIND_LABEL = {
  table: "Table",
  view: "View",
  materialized_view: "Materialized view",
} as const;
const KIND_ICON = { table: Table2, view: Eye, materialized_view: Layers } as const;
const NO_RELATIONSHIPS: RelationshipInfo[] = [];

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        {count !== undefined ? <span className="ml-1.5 font-normal">({count})</span> : null}
      </h3>
      {children}
    </section>
  );
}

function RelationshipRow({
  connectionId,
  relationship,
  direction,
  onCanvas,
}: {
  connectionId: string;
  relationship: RelationshipInfo;
  direction: "outgoing" | "incoming";
  onCanvas: ReadonlySet<string>;
}) {
  const other = direction === "outgoing" ? relationship.target : relationship.source;
  const ref = { schema: other.schema, name: other.table };
  const id = nodeIdFor(ref);
  const label = other.schema === "public" ? other.table : `${other.schema}.${other.table}`;
  const here = onCanvas.has(id);

  function goTo() {
    const store = useCanvasStore.getState();
    store.selectOnly(connectionId, id);
    store.requestFocus(connectionId, id);
  }

  return (
    <li className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <span className="text-muted-foreground">
            {direction === "outgoing" ? "references " : "referenced by "}
          </span>
          <span className="font-medium">{label}</span>
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {relationship.source.columns.join(", ")} → {relationship.target.columns.join(", ")} ·{" "}
          {relationship.cardinality}
        </div>
      </div>
      {here ? (
        <Button variant="ghost" size="xs" onClick={goTo} aria-label={`Go to ${label}`}>
          Go to
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void addTablesToCanvas(connectionId, [ref], { focus: true })}
          aria-label={`Add ${label} to the canvas`}
        >
          <Plus aria-hidden="true" /> Add
        </Button>
      )}
    </li>
  );
}

function TableInspector({
  connectionId,
  nodeId,
  entry,
  relationships,
  onCanvas,
}: {
  connectionId: string;
  nodeId: string;
  entry: TableDetailsEntry;
  relationships: RelationshipInfo[];
  onCanvas: ReadonlySet<string>;
}) {
  const { table, columns, constraints, indexes } = entry;
  const Icon = KIND_ICON[table.kind];

  const keys = useMemo(() => {
    const of = (kind: "primary_key" | "foreign_key") =>
      new Set(constraints.filter((c) => c.kind === kind).flatMap((c) => c.columns));
    return { primary: of("primary_key"), foreign: of("foreign_key") };
  }, [constraints]);

  const outgoing = relationships.filter(
    (r) => nodeIdFor({ schema: r.source.schema, name: r.source.table }) === nodeId,
  );
  const incoming = relationships.filter(
    (r) => nodeIdFor({ schema: r.target.schema, name: r.target.table }) === nodeId,
  );

  return (
    <div className="flex flex-col gap-4 p-3">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="truncate text-base font-semibold">{table.name}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{KIND_LABEL[table.kind]}</Badge>
          <Badge variant="outline">{table.schema}</Badge>
        </div>
        {table.comment ? <p className="text-xs text-muted-foreground">{table.comment}</p> : null}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-1 text-xs">
          <dt className="text-muted-foreground">Rows (estimate)</dt>
          <dd>
            {table.estimatedRowCount === null
              ? "unknown"
              : `≈ ${new Intl.NumberFormat().format(table.estimatedRowCount)}`}
          </dd>
          <dt className="text-muted-foreground">Columns</dt>
          <dd>{columns.length}</dd>
          <dt className="text-muted-foreground">Constraints</dt>
          <dd>{constraints.length}</dd>
          <dt className="text-muted-foreground">Indexes</dt>
          <dd>{indexes.length}</dd>
        </dl>
      </header>

      <Section title="Columns" count={columns.length}>
        <ul className="flex flex-col">
          {columns.map((column) => (
            <li
              key={column.name}
              className="flex items-center gap-1.5 border-b py-1 text-xs last:border-b-0"
              title={column.defaultValue ? `default ${column.defaultValue}` : undefined}
            >
              <span className="flex w-4 shrink-0 justify-center">
                {keys.primary.has(column.name) ? (
                  <KeyRound className="size-3 text-amber-500" aria-label="primary key" />
                ) : keys.foreign.has(column.name) ? (
                  <Link2 className="size-3 text-sky-500" aria-label="foreign key" />
                ) : null}
              </span>
              <span className="truncate font-medium">{column.name}</span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                {column.dataType}
                {column.nullable ? "" : " not null"}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Relationships" count={outgoing.length + incoming.length}>
        {outgoing.length + incoming.length === 0 ? (
          <p className="text-xs text-muted-foreground">No foreign keys involve this table.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {outgoing.map((r) => (
              <RelationshipRow
                key={`o-${r.name}`}
                connectionId={connectionId}
                relationship={r}
                direction="outgoing"
                onCanvas={onCanvas}
              />
            ))}
            {incoming.map((r) => (
              <RelationshipRow
                key={`i-${r.source.table}-${r.name}`}
                connectionId={connectionId}
                relationship={r}
                direction="incoming"
                onCanvas={onCanvas}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Constraints" count={constraints.length}>
        {constraints.length === 0 ? (
          <p className="text-xs text-muted-foreground">None.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {constraints.map((c) => (
              <li key={c.name} className="text-xs">
                <span className="font-medium">{c.name}</span>{" "}
                <span className="text-muted-foreground">{c.kind.replace("_", " ")}</span>
                {c.definition ? (
                  <code
                    className="block truncate text-[11px] text-muted-foreground"
                    title={c.definition}
                  >
                    {c.definition}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Indexes" count={indexes.length}>
        {indexes.length === 0 ? (
          <p className="text-xs text-muted-foreground">None.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {indexes.map((i) => (
              <li key={i.name} className="text-xs">
                <span className="font-medium">{i.name}</span>{" "}
                <span className="text-muted-foreground">
                  {i.method}
                  {i.primary ? ", primary" : i.unique ? ", unique" : ""}
                </span>
                <code
                  className="block truncate text-[11px] text-muted-foreground"
                  title={i.columns.join(", ")}
                >
                  {i.columns.join(", ")}
                </code>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

export function InspectorPanel({
  connectionId,
  hiddenIds,
}: {
  connectionId: string;
  hiddenIds: ReadonlySet<string>;
}) {
  const nodes = useCanvasStore((s) => s.canvases[connectionId]?.nodes);
  const metadata = useMetadataStore((s) => s.byConnection[connectionId]);
  const open = useCanvasViewStore((s) => viewOf(s.views, connectionId).inspectorOpen);
  const setOpen = useCanvasViewStore.getState().setInspectorOpen;

  if (!open) return null;

  const onCanvas = new Set((nodes ?? []).map((n) => n.id));
  const selected = (nodes ?? []).filter((n) => n.selected && !hiddenIds.has(n.id));
  const only = selected.length === 1 ? selected[0] : undefined;
  const entry = only ? metadata?.tables[only.id] : undefined;

  return (
    <aside
      aria-label="Inspector"
      className="flex w-80 shrink-0 flex-col overflow-y-auto border-l bg-background"
    >
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-sm font-medium">Inspector</span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setOpen(connectionId, false)}
          aria-label="Close the inspector"
        >
          <PanelRightClose aria-hidden="true" />
        </Button>
      </div>

      {only && only.data.missing ? (
        <p className="p-3 text-sm text-muted-foreground">
          {only.data.name} no longer exists in the database. Press Delete to remove it from the
          layout.
        </p>
      ) : only && entry ? (
        <TableInspector
          key={only.id}
          connectionId={connectionId}
          nodeId={only.id}
          entry={entry}
          relationships={metadata?.relationships ?? NO_RELATIONSHIPS}
          onCanvas={onCanvas}
        />
      ) : selected.length > 1 ? (
        <div className="flex flex-col gap-2 p-3 text-sm">
          <p>
            <strong>{selected.length} tables</strong> selected.
          </p>
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {selected.slice(0, 15).map((n) => (
              <li key={n.id} className="truncate">
                {n.data.schema === "public" ? n.data.name : `${n.data.schema}.${n.data.name}`}
              </li>
            ))}
            {selected.length > 15 ? <li>and {selected.length - 15} more</li> : null}
          </ul>
          <p className="text-xs text-muted-foreground">Select one table to see its details.</p>
        </div>
      ) : (
        <p className="p-3 text-sm text-muted-foreground">
          Select a table on the canvas to see its columns, relationships, constraints and indexes.
        </p>
      )}
    </aside>
  );
}
