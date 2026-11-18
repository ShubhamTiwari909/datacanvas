/**
 * The detail panel for one table, view or materialized view: its columns
 * (with key badges), constraints, indexes and relationships, all read from the
 * database's structure, and, once data access is switched on for the connection,
 * its rows (the Data section, `features/data`).
 */
"use client";

import { Fragment, useState } from "react";
import { PencilRuler } from "lucide-react";
import type {
  ColumnInfo,
  ConstraintInfo,
  IndexInfo,
  RelationshipInfo,
  TableInfo,
} from "@datacanvas/database-core";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataSection } from "@/features/data/data-section";
import { AlterTableDialog } from "@/features/writes/alter-table-dialog";
import { useConnectionWrites, useStructureVersion, writesReady } from "@/stores/writes-store";
import { useAsyncData } from "@/lib/use-async-data";
import { KIND_LABEL } from "@/components/relation-kind";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { getRelationships, getTableDetails, getTables } from "./api";

const ACTION_LABEL = {
  no_action: "no action",
  restrict: "restrict",
  cascade: "cascade",
  set_null: "set null",
  set_default: "set default",
} as const;

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
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        {count !== undefined ? <span className="ml-2 font-normal">({count})</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

const columnList = (columns: string[]): string => columns.join(", ");

function ColumnsTable({
  columns,
  constraints,
}: {
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
}) {
  // Which columns take part in which kind of constraint, for the badges.
  const columnsOf = (kind: ConstraintInfo["kind"]): Set<string> =>
    new Set(constraints.filter((c) => c.kind === kind).flatMap((c) => c.columns));
  const primary = columnsOf("primary_key");
  const foreign = columnsOf("foreign_key");
  const unique = columnsOf("unique");

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Nullable</th>
            <th className="px-3 py-2 font-medium">Default</th>
            <th className="px-3 py-2 font-medium">Comment</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column.name} className="border-t">
              <td className="px-3 py-2 text-muted-foreground">{column.ordinalPosition}</td>
              <td className="px-3 py-2">
                <span className="font-medium">{column.name}</span>
                <span className="ml-2 inline-flex gap-1">
                  {primary.has(column.name) ? <Badge>PK</Badge> : null}
                  {foreign.has(column.name) ? <Badge variant="secondary">FK</Badge> : null}
                  {unique.has(column.name) ? <Badge variant="outline">unique</Badge> : null}
                </span>
              </td>
              <td className="px-3 py-2 font-mono text-xs">{column.dataType}</td>
              <td className="px-3 py-2">{column.nullable ? "yes" : "no"}</td>
              <td className="px-3 py-2 font-mono text-xs">{column.defaultValue ?? ""}</td>
              <td className="px-3 py-2 text-muted-foreground">{column.comment ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConstraintsList({ constraints }: { constraints: ConstraintInfo[] }) {
  if (constraints.length === 0) return <Empty>No constraints.</Empty>;
  const LABEL = {
    primary_key: "Primary key",
    foreign_key: "Foreign key",
    unique: "Unique",
    check: "Check",
  } as const;
  return (
    <ul className="flex flex-col gap-2">
      {constraints.map((c) => (
        <li key={c.name} className="rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{LABEL[c.kind]}</Badge>
            <span className="font-medium">{c.name}</span>
            {c.columns.length > 0 ? (
              <span className="text-muted-foreground">on {columnList(c.columns)}</span>
            ) : null}
          </div>
          {c.definition ? (
            <code className="mt-2 block text-xs text-muted-foreground">{c.definition}</code>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function IndexesList({ indexes }: { indexes: IndexInfo[] }) {
  if (indexes.length === 0) return <Empty>No indexes.</Empty>;
  return (
    <ul className="flex flex-col gap-2">
      {indexes.map((index) => (
        <li key={index.name} className="rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{index.name}</span>
            <Badge variant="outline">{index.method}</Badge>
            {index.primary ? <Badge>primary</Badge> : null}
            {index.unique && !index.primary ? <Badge variant="secondary">unique</Badge> : null}
            <span className="text-muted-foreground">on {columnList(index.columns)}</span>
          </div>
          {index.definition ? (
            <code className="mt-2 block text-xs text-muted-foreground">{index.definition}</code>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RelationshipRow({
  relationship,
  direction,
  onOpen,
}: {
  relationship: RelationshipInfo;
  direction: "outgoing" | "incoming";
  onOpen: (schema: string, table: string) => void;
}) {
  // Outgoing: this table holds the foreign key and points at `target`.
  // Incoming: another table (`source`) holds a foreign key pointing here.
  const other = direction === "outgoing" ? relationship.target : relationship.source;
  return (
    <li className="rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">
          {direction === "outgoing" ? "references" : "referenced by"}
        </span>
        <button
          type="button"
          className="font-medium underline-offset-4 hover:underline"
          onClick={() => onOpen(other.schema, other.table)}
        >
          {other.schema === "public" ? other.table : `${other.schema}.${other.table}`}
        </button>
        <Badge variant="outline">{relationship.cardinality}</Badge>
      </div>
      <p className="mt-1 font-mono text-xs text-muted-foreground">
        {relationship.source.table}({columnList(relationship.source.columns)}) →{" "}
        {relationship.target.table}({columnList(relationship.target.columns)})
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {relationship.name} · on delete {ACTION_LABEL[relationship.onDelete]} · on update{" "}
        {ACTION_LABEL[relationship.onUpdate]}
      </p>
    </li>
  );
}

export function TableDetails({
  connectionId,
  schema,
  table,
}: {
  connectionId: string;
  schema: string;
  table: string;
}) {
  const selectTable = useWorkspaceStore((s) => s.selectTable);
  // A change of structure made from DataCanvas reads everything again.
  const structureVersion = useStructureVersion(connectionId);
  const writes = useConnectionWrites(connectionId);
  const [editingStructure, setEditingStructure] = useState(false);
  const key = `${connectionId}/${schema}/${table}/${structureVersion}`;

  // Three independent requests, shown as they arrive.
  const details = useAsyncData(() => getTableDetails(connectionId, schema, table), key);
  const relationships = useAsyncData(() => getRelationships(connectionId), key);
  const tables = useAsyncData(() => getTables(connectionId, schema), key);

  const info: TableInfo | undefined =
    tables.state.status === "success" ? tables.state.data.find((t) => t.name === table) : undefined;
  const open = (s: string, t: string) => selectTable({ schema: s, name: t });

  const outgoing =
    relationships.state.status === "success"
      ? relationships.state.data.filter(
          (r) => r.source.schema === schema && r.source.table === table,
        )
      : [];
  const incoming =
    relationships.state.status === "success"
      ? relationships.state.data.filter(
          (r) => r.target.schema === schema && r.target.table === table,
        )
      : [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">
            <span className="text-muted-foreground">{schema}.</span>
            {table}
          </h2>
          {info ? <Badge variant="secondary">{KIND_LABEL[info.kind]}</Badge> : null}
          {info?.estimatedRowCount != null ? (
            <Badge variant="outline">
              ≈ {new Intl.NumberFormat().format(info.estimatedRowCount)} rows
            </Badge>
          ) : null}
          {writesReady(writes.status) &&
          info?.kind === "table" &&
          details.state.status === "success" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => setEditingStructure(true)}
            >
              <PencilRuler aria-hidden="true" />
              Edit structure
            </Button>
          ) : null}
        </div>
        {info?.comment ? <p className="text-sm text-muted-foreground">{info.comment}</p> : null}
      </header>

      <DataSection connectionId={connectionId} schema={schema} table={table} info={info} />

      {details.state.status === "loading" ? <LoadingState label="Loading table…" /> : null}
      {details.state.status === "error" ? (
        <ErrorState
          title="Could not load this table"
          message={details.state.error.message}
          onRetry={details.reload}
        />
      ) : null}

      {details.state.status === "success" ? (
        <Fragment>
          <AlterTableDialog
            connectionId={connectionId}
            table={{ schema, name: table }}
            structure={details.state.data}
            open={editingStructure && writesReady(writes.status)}
            onClose={() => setEditingStructure(false)}
          />
          <Section title="Columns" count={details.state.data.columns.length}>
            <ColumnsTable
              columns={details.state.data.columns}
              constraints={details.state.data.constraints}
            />
          </Section>
          <Section title="Constraints" count={details.state.data.constraints.length}>
            <ConstraintsList constraints={details.state.data.constraints} />
          </Section>
          <Section title="Indexes" count={details.state.data.indexes.length}>
            <IndexesList indexes={details.state.data.indexes} />
          </Section>
        </Fragment>
      ) : null}

      <Section
        title="Relationships"
        count={
          relationships.state.status === "success" ? outgoing.length + incoming.length : undefined
        }
      >
        {relationships.state.status === "loading" ? (
          <LoadingState label="Loading relationships…" />
        ) : null}
        {relationships.state.status === "error" ? (
          <ErrorState
            title="Could not load relationships"
            message={relationships.state.error.message}
            onRetry={relationships.reload}
          />
        ) : null}
        {relationships.state.status === "success" ? (
          outgoing.length + incoming.length === 0 ? (
            <Empty>No foreign keys involve this table.</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {outgoing.map((r) => (
                <RelationshipRow
                  key={`o-${r.name}`}
                  relationship={r}
                  direction="outgoing"
                  onOpen={open}
                />
              ))}
              {incoming.map((r) => (
                <RelationshipRow
                  key={`i-${r.name}`}
                  relationship={r}
                  direction="incoming"
                  onOpen={open}
                />
              ))}
            </ul>
          )
        ) : null}
      </Section>
    </div>
  );
}
