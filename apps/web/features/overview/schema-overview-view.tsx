/**
 * The "Overview" tab: one card per schema with what it contains and how it
 * connects to the rest of the database.
 *
 * It answers "what is in this database?" before the user has put a single table
 * on the canvas. Every table name is a button that puts that table on the
 * canvas and switches to it; "Add to canvas" does the same for a whole schema.
 */
"use client";

import { ArrowDownToLine, ArrowUpFromLine, Layers, Link2Off } from "lucide-react";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { addSchemaToCanvas, addTablesToCanvas } from "@/features/canvas/add-tables";
import { useAsyncData } from "@/lib/use-async-data";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { loadDatabaseOverview } from "./load-overview";
import type { DatabaseOverview, SchemaOverview } from "./schema-overview";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** How many orphan names to list before "and N more". */
const ORPHANS_SHOWN = 8;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function TableButton({
  name,
  detail,
  onClick,
}: {
  name: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-2">
      <button
        type="button"
        onClick={onClick}
        className="truncate rounded text-left font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-2"
        aria-label={`Show ${name} on the canvas`}
        title={`Show ${name} on the canvas`}
      >
        {name}
      </button>
      {detail ? <span className="shrink-0 text-xs text-muted-foreground">{detail}</span> : null}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </section>
  );
}

function SchemaCard({
  overview,
  connectionId,
  onShow,
}: {
  overview: SchemaOverview;
  connectionId: string;
  onShow: (schema: string, name: string) => void;
}) {
  const setView = useWorkspaceStore((s) => s.setView);
  const o = overview;
  const objects = o.tableCount + o.viewCount + o.materializedViewCount + o.foreignTableCount;

  return (
    <article
      aria-label={`Schema ${o.schema}`}
      className="flex flex-col gap-4 rounded-xl border bg-card p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{o.schema}</h3>
          <p className="text-xs text-muted-foreground">
            {[
              plural(o.tableCount, "table"),
              o.viewCount > 0 ? plural(o.viewCount, "view") : null,
              o.materializedViewCount > 0
                ? plural(o.materializedViewCount, "materialized view")
                : null,
              o.foreignTableCount > 0 ? plural(o.foreignTableCount, "foreign table") : null,
            ]
              .filter(Boolean)
              .join(", ")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={objects === 0}
          onClick={() => {
            void addSchemaToCanvas(connectionId, o.schema).then((ok) => {
              if (ok) setView("canvas");
            });
          }}
        >
          <Layers aria-hidden="true" />
          Add to canvas
        </Button>
      </header>

      <div className="flex gap-6">
        <Stat
          label="rows (estimate)"
          value={o.estimatedRows === null ? "unknown" : `≈ ${compact.format(o.estimatedRows)}`}
        />
        <Stat label="relationships inside" value={String(o.relationshipsInside)} />
        <Stat label="with other schemas" value={String(o.relationshipsOut + o.relationshipsIn)} />
      </div>

      {o.neighbours.length > 0 ? (
        <Section title="Connected schemas">
          <ul className="flex flex-wrap gap-1.5">
            {o.neighbours.map((n) => (
              <li key={n.schema}>
                <Badge variant="secondary" className="gap-1">
                  {n.schema}
                  <span className="text-muted-foreground">{n.count}</span>
                </Badge>
              </li>
            ))}
          </ul>
          <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <ArrowUpFromLine className="size-3" aria-hidden="true" />
              {o.relationshipsOut} point out
            </span>
            <span className="inline-flex items-center gap-1">
              <ArrowDownToLine className="size-3" aria-hidden="true" />
              {o.relationshipsIn} point in
            </span>
          </p>
        </Section>
      ) : null}

      {o.mostConnected.length > 0 ? (
        <Section title="Most connected">
          <ul className="flex flex-col gap-1">
            {o.mostConnected.map((t) => (
              <TableButton
                key={t.name}
                name={t.name}
                detail={plural(t.degree, "relationship")}
                onClick={() => onShow(o.schema, t.name)}
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {o.largest.length > 0 ? (
        <Section title="Largest (estimated rows)">
          <ul className="flex flex-col gap-1">
            {o.largest.map((t) => (
              <TableButton
                key={t.name}
                name={t.name}
                detail={`≈ ${compact.format(t.estimatedRows)}`}
                onClick={() => onShow(o.schema, t.name)}
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {o.orphans.length > 0 ? (
        <Section title="No declared relationships">
          <ul className="flex flex-col gap-1">
            {o.orphans.slice(0, ORPHANS_SHOWN).map((name) => (
              <TableButton key={name} name={name} onClick={() => onShow(o.schema, name)} />
            ))}
          </ul>
          {o.orphans.length > ORPHANS_SHOWN ? (
            <p className="text-xs text-muted-foreground">
              and {o.orphans.length - ORPHANS_SHOWN} more
            </p>
          ) : null}
        </Section>
      ) : null}
    </article>
  );
}

function Summary({ overview }: { overview: DatabaseOverview }) {
  const o = overview;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-8">
        <Stat label={o.schemaCount === 1 ? "schema" : "schemas"} value={String(o.schemaCount)} />
        <Stat label="tables" value={String(o.tableCount)} />
        <Stat label="views" value={String(o.viewCount + o.materializedViewCount)} />
        {o.foreignTableCount > 0 ? (
          <Stat label="foreign tables" value={String(o.foreignTableCount)} />
        ) : null}
        <Stat label="relationships" value={String(o.relationshipCount)} />
        <Stat label="across schemas" value={String(o.crossSchemaRelationships)} />
      </div>
      {o.tableCount > 0 && o.relationshipCount === 0 ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Link2Off className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          This database declares no foreign keys, so DataCanvas has no relationships to draw.
          Relationships are only ever read from real constraints, never guessed from names.
        </p>
      ) : null}
    </div>
  );
}

export function SchemaOverviewView({ connectionId }: { connectionId: string }) {
  const setView = useWorkspaceStore((s) => s.setView);
  const { state, reload } = useAsyncData(() => loadDatabaseOverview(connectionId), connectionId);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <LoadingState label="Reading the structure…" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <ErrorState
          title="Could not load the overview"
          message={state.error.message}
          onRetry={reload}
        />
      </div>
    );
  }

  const overview = state.data;
  const show = (schema: string, name: string): void => {
    void addTablesToCanvas(connectionId, [{ schema, name }], { focus: true }).then((ok) => {
      if (ok) setView("canvas");
    });
  };

  return (
    <div className="flex flex-col gap-6 p-4">
      <header className="flex flex-col gap-3">
        <h2 className="flex flex-wrap items-baseline gap-x-3 text-lg font-semibold">
          Overview
          <span className="text-sm font-normal text-muted-foreground">
            Click a table to show it on the canvas.
          </span>
        </h2>
        <Summary overview={overview} />
      </header>
      {overview.schemas.length === 0 ? (
        <p className="text-sm text-muted-foreground">This database has no user schemas.</p>
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
          {overview.schemas.map((schema) => (
            <SchemaCard
              key={schema.schema}
              overview={schema}
              connectionId={connectionId}
              onShow={show}
            />
          ))}
        </div>
      )}
    </div>
  );
}
