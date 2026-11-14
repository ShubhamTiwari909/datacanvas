/**
 * The result of a comparison: counts, then one collapsible entry per changed
 * table. Colour is never the only signal: every row also says "added",
 * "removed" or "changed" in words.
 */
"use client";

import {
  diffToMarkdown,
  OBJECT_KINDS,
  OBJECT_LABELS,
  type Counts,
  type NamedItem,
  type SchemaDiff,
  type TableDiff,
} from "@datacanvas/database-core";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/copy-button";

const STATUS_VARIANT = {
  added: "secondary",
  removed: "destructive",
  changed: "outline",
} as const;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function StatusBadge({ status }: { status: "added" | "removed" | "changed" }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
}

/** A before or after value: short ones inline, long or multi-line ones (a view query, a function body) as a block. */
function Value({ text }: { text: string }) {
  if (text.length > 80 || text.includes("\n")) {
    return (
      <pre className="mt-0.5 max-h-60 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-words">
        {text}
      </pre>
    );
  }
  return <code className="break-all">{text}</code>;
}

function ItemRows({ label, items }: { label: string; items: NamedItem<unknown>[] }) {
  return items.map((item) => (
    <li key={`${label}:${item.name}`} className="flex flex-col gap-0.5 text-sm">
      <span className="flex flex-wrap items-center gap-2">
        <StatusBadge status={item.status} />
        <span className="text-xs text-muted-foreground">{label}</span>
        <code className="font-mono">{item.name}</code>
      </span>
      {item.status === "changed" ? (
        <ul className="ml-4 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {item.changes.map((c) => (
            <li key={c.field}>
              {c.field}: <Value text={c.before} /> → <Value text={c.after} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  ));
}

function TableEntry({ table }: { table: TableDiff }) {
  const rows =
    table.columns.length +
    table.constraints.length +
    table.indexes.length +
    table.relationships.length +
    table.table.length;
  const detail =
    table.status === "added"
      ? plural(table.after?.columns.length ?? 0, "column")
      : table.status === "removed"
        ? `it had ${plural(table.before?.columns.length ?? 0, "column")}`
        : plural(rows, "change");
  return (
    <li className="rounded-lg border bg-card">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3">
          <StatusBadge status={table.status} />
          <span className="font-mono text-sm font-medium">{table.name}</span>
          <span className="text-xs text-muted-foreground">{table.schema}</span>
          <span className="text-xs text-muted-foreground">{detail}</span>
        </summary>
        {table.status === "changed" ? (
          <ul className="flex flex-col gap-2 border-t p-3">
            {table.table.map((c) => (
              <li key={c.field} className="text-sm">
                <StatusBadge status="changed" />{" "}
                <span className="text-xs text-muted-foreground">table {c.field}</span>{" "}
                <code className="break-all text-xs">{c.before}</code> →{" "}
                <code className="break-all text-xs">{c.after}</code>
              </li>
            ))}
            <ItemRows label="column" items={table.columns} />
            <ItemRows label="constraint" items={table.constraints} />
            <ItemRows label="index" items={table.indexes} />
            <ItemRows label="foreign key" items={table.relationships} />
          </ul>
        ) : null}
      </details>
    </li>
  );
}

function CountCell({ label, counts }: { label: string; counts: Counts }) {
  return (
    <div className="flex flex-col rounded-lg border p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">
        <span className="font-medium">{counts.added}</span> added ·{" "}
        <span className="font-medium">{counts.removed}</span> removed ·{" "}
        <span className="font-medium">{counts.changed}</span> changed
      </span>
    </div>
  );
}

const NOT_COMPARED =
  "Views, types, sequences, functions, triggers, extensions and policies were not compared: one side was saved before they were recorded. Take a new snapshot to compare them.";

export function DiffView({
  diff,
  before,
  after,
}: {
  diff: SchemaDiff;
  before: string;
  after: string;
}) {
  if (diff.isEmpty) {
    return (
      <p role="status" className="text-sm">
        No differences in schemas, tables, columns, constraints, indexes or foreign keys
        {diff.objects === null
          ? ""
          : ", views, types, sequences, functions, triggers, extensions or policies"}{" "}
        between <strong>{before}</strong> and <strong>{after}</strong>.
        {diff.objects === null ? (
          <span className="block text-muted-foreground">{NOT_COMPARED}</span>
        ) : null}
      </p>
    );
  }
  const s = diff.summary;
  const objects = diff.objects;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <strong>{before}</strong> → <strong>{after}</strong>
        </p>
        <CopyButton text={diffToMarkdown(diff, { before, after })} label="Copy as Markdown" />
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <CountCell label="Schemas" counts={s.schemas} />
        <CountCell label="Tables" counts={s.tables} />
        <CountCell label="Columns" counts={s.columns} />
        <CountCell label="Constraints" counts={s.constraints} />
        <CountCell label="Indexes" counts={s.indexes} />
        <CountCell label="Foreign keys" counts={s.relationships} />
        {OBJECT_KINDS.filter((kind) => objects !== null && objects[kind].length > 0).map((kind) => (
          <CountCell key={kind} label={OBJECT_LABELS[kind].many} counts={s.objects[kind]} />
        ))}
      </div>
      {objects === null ? (
        <p role="note" className="text-sm text-muted-foreground">
          {NOT_COMPARED}
        </p>
      ) : null}
      {diff.schemasAdded.length + diff.schemasRemoved.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {diff.schemasAdded.map((name) => (
            <li key={`+${name}`} className="flex items-center gap-2">
              <StatusBadge status="added" /> schema <code className="font-mono">{name}</code>
            </li>
          ))}
          {diff.schemasRemoved.map((name) => (
            <li key={`-${name}`} className="flex items-center gap-2">
              <StatusBadge status="removed" /> schema <code className="font-mono">{name}</code>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="flex flex-col gap-2">
        {diff.tables.map((table) => (
          <TableEntry key={`${table.schema}.${table.name}`} table={table} />
        ))}
      </ul>
      {objects !== null
        ? OBJECT_KINDS.filter((kind) => objects[kind].length > 0).map((kind) => (
            <section
              key={kind}
              aria-label={OBJECT_LABELS[kind].many}
              className="flex flex-col gap-2"
            >
              <h3 className="text-sm font-semibold">{OBJECT_LABELS[kind].many}</h3>
              <ul className="flex flex-col gap-2 rounded-lg border bg-card p-3">
                <ItemRows label={OBJECT_LABELS[kind].one} items={objects[kind]} />
              </ul>
            </section>
          ))
        : null}
      <p className="text-xs text-muted-foreground">
        Items are matched by name: a renamed table or column shows as one removed and one added.
        Column order is ignored. A function is told apart by its name and argument list.
      </p>
    </div>
  );
}
