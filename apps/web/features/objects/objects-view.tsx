/**
 * The "Objects" tab: everything in the database that is not a table, column,
 * index or foreign key. Views (with their query and what they read), types,
 * sequences, functions, triggers, extensions and row-level-security policies.
 *
 * Definitions and settings from the catalogs only: no table rows and no
 * sequence values are read, and nothing here changes the database.
 */
"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  displayName,
  OBJECT_LABELS,
  type DatabaseObjects,
  type ObjectKind,
} from "@datacanvas/database-core";
import { CopyButton } from "@/components/copy-button";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { addTablesToCanvas } from "@/features/canvas/add-tables";
import { getObjects } from "@/features/explorer/api";
import { useAsyncData } from "@/lib/use-async-data";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { filterObjects, policyGroups, readersOf, viewReaders } from "./object-lists";

/** Kinds shown as tabs. Row-level security settings are shown with the policies. */
const KINDS: ObjectKind[] = [
  "views",
  "types",
  "sequences",
  "functions",
  "triggers",
  "extensions",
  "policies",
];

const SHOWN_AT_FIRST = 100;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function Code({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-end">
        <CopyButton text={text} label={label} />
      </div>
      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  );
}

function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Item({
  title,
  badges,
  children,
}: {
  title: string;
  badges?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="rounded-lg border bg-card">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3">
          <span className="font-mono text-sm font-medium break-all">{title}</span>
          {badges}
        </summary>
        <div className="flex flex-col gap-3 border-t p-3">{children}</div>
      </details>
    </li>
  );
}

function TableLink({
  schema,
  name,
  onShow,
}: {
  schema: string;
  name: string;
  onShow: (schema: string, name: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onShow(schema, name)}
      title={`Show ${name} on the canvas`}
      aria-label={`Show ${schema}.${name} on the canvas`}
      className="rounded font-mono text-sm underline-offset-2 hover:underline focus-visible:outline-2"
    >
      {schema}.{name}
    </button>
  );
}

function List({ children }: { children: React.ReactNode }) {
  return <ul className="flex flex-col gap-2">{children}</ul>;
}

function Section({
  kind,
  objects,
  query,
  onShow,
}: {
  kind: ObjectKind;
  objects: DatabaseObjects;
  query: string;
  onShow: (schema: string, name: string) => void;
}) {
  const [all, setAll] = useState(false);
  const readers = viewReaders(objects.views);

  // Each kind builds its own list; the cap keeps a database with thousands of functions responsive.
  const cap = <T,>(items: T[]): { shown: T[]; hidden: number } =>
    all
      ? { shown: items, hidden: 0 }
      : {
          shown: items.slice(0, SHOWN_AT_FIRST),
          hidden: Math.max(0, items.length - SHOWN_AT_FIRST),
        };

  let rows: React.ReactNode[] = [];
  let total = 0;
  let hidden = 0;

  if (kind === "views") {
    const items = filterObjects("views", objects.views, query);
    total = items.length;
    const view = cap(items);
    hidden = view.hidden;
    rows = view.shown.map((v) => {
      const readBy = readersOf(readers, v.schema, v.name);
      return (
        <Item
          key={displayName.views(v)}
          title={displayName.views(v)}
          badges={
            <>
              <Badge variant="secondary">{v.materialized ? "materialized view" : "view"}</Badge>
              <span className="text-xs text-muted-foreground">
                reads {plural(v.dependsOn.length, "relation")}
              </span>
            </>
          }
        >
          {v.comment ? <p className="text-sm">{v.comment}</p> : null}
          <Facts
            rows={[
              [
                "Reads",
                v.dependsOn.length === 0 ? (
                  "nothing (no table or view)"
                ) : (
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {v.dependsOn.map((d) => (
                      <TableLink key={`${d.schema}.${d.name}`} {...d} onShow={onShow} />
                    ))}
                  </span>
                ),
              ],
              [
                "Read by",
                readBy.length === 0 ? (
                  "no other view"
                ) : (
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {readBy.map((r) => (
                      <TableLink
                        key={`${r.schema}.${r.name}`}
                        schema={r.schema}
                        name={r.name}
                        onShow={onShow}
                      />
                    ))}
                  </span>
                ),
              ],
            ]}
          />
          <Code text={v.definition} label={`Copy the query of ${v.name}`} />
        </Item>
      );
    });
  } else if (kind === "types") {
    const items = filterObjects("types", objects.types, query);
    total = items.length;
    const view = cap(items);
    hidden = view.hidden;
    rows = view.shown.map((t) => (
      <Item
        key={displayName.types(t)}
        title={displayName.types(t)}
        badges={<Badge variant="secondary">{t.kind}</Badge>}
      >
        {t.comment ? <p className="text-sm">{t.comment}</p> : null}
        {t.kind === "enum" ? (
          <Facts
            rows={[
              [
                "Values",
                <span key="v" className="flex flex-wrap gap-1">
                  {t.values.map((value, i) => (
                    <Badge key={`${i}:${value}`} variant="outline">
                      {value}
                    </Badge>
                  ))}
                </span>,
              ],
            ]}
          />
        ) : null}
        {t.kind === "composite" ? (
          <Facts
            rows={t.attributes.map((a): [string, React.ReactNode] => [
              a.name,
              <code key={a.name}>{a.dataType}</code>,
            ])}
          />
        ) : null}
        {t.kind === "domain" || t.kind === "range" ? (
          <Facts
            rows={[
              [
                t.kind === "domain" ? "Based on" : "Range of",
                <code key="b">{t.baseType ?? "?"}</code>,
              ],
              ...(t.defaultValue !== null
                ? ([["Default", <code key="d">{t.defaultValue}</code>]] as Array<
                    [string, React.ReactNode]
                  >)
                : []),
              ...(t.constraints.length > 0
                ? ([
                    [
                      "Rules",
                      <span key="c" className="flex flex-col gap-1">
                        {t.constraints.map((c) => (
                          <code key={c}>{c}</code>
                        ))}
                      </span>,
                    ],
                  ] as Array<[string, React.ReactNode]>)
                : []),
            ]}
          />
        ) : null}
      </Item>
    ));
  } else if (kind === "sequences") {
    const items = filterObjects("sequences", objects.sequences, query);
    total = items.length;
    const view = cap(items);
    hidden = view.hidden;
    rows = view.shown.map((s) => (
      <Item
        key={displayName.sequences(s)}
        title={displayName.sequences(s)}
        badges={
          s.ownedBy ? (
            <span className="text-xs text-muted-foreground">
              owned by {s.ownedBy.table}.{s.ownedBy.column}
            </span>
          ) : (
            <Badge variant="outline">standalone</Badge>
          )
        }
      >
        <Facts
          rows={[
            ["Type", s.dataType],
            ["Starts at", s.start],
            ["Step", s.increment],
            ["Range", `${s.min} to ${s.max}`],
            ["Cache", s.cache],
            ["Wraps around", s.cycle ? "yes" : "no"],
          ]}
        />
        <p className="text-xs text-muted-foreground">
          The current value is data, so it is not read.
        </p>
      </Item>
    ));
  } else if (kind === "functions") {
    const items = filterObjects("functions", objects.functions, query);
    total = items.length;
    const view = cap(items);
    hidden = view.hidden;
    rows = view.shown.map((f) => (
      <Item
        key={displayName.functions(f)}
        title={`${f.schema}.${f.name}(${f.arguments})`}
        badges={
          <>
            <Badge variant="secondary">{f.kind}</Badge>
            <Badge variant="outline">{f.language}</Badge>
            {f.securityDefiner ? <Badge variant="destructive">security definer</Badge> : null}
          </>
        }
      >
        {f.comment ? <p className="text-sm">{f.comment}</p> : null}
        <Facts
          rows={[
            ...(f.returns !== null
              ? ([["Returns", <code key="r">{f.returns}</code>]] as Array<
                  [string, React.ReactNode]
                >)
              : []),
            ["Volatility", f.volatility],
            [
              "Runs with the rights of",
              f.securityDefiner ? "its owner (security definer)" : "the caller",
            ],
          ]}
        />
        <Code text={f.definition} label={`Copy the definition of ${f.name}`} />
      </Item>
    ));
  } else if (kind === "triggers") {
    const items = filterObjects("triggers", objects.triggers, query);
    total = items.length;
    const view = cap(items);
    hidden = view.hidden;
    rows = view.shown.map((t) => (
      <Item
        key={displayName.triggers(t)}
        title={`${t.name} on ${t.schema}.${t.table}`}
        badges={
          <>
            <Badge variant="secondary">
              {t.timing.replace("_", " ")} {t.events.join(" or ")}
            </Badge>
            {t.state !== "enabled" ? <Badge variant="destructive">{t.state}</Badge> : null}
          </>
        }
      >
        <Facts
          rows={[
            ["Table", <TableLink key="t" schema={t.schema} name={t.table} onShow={onShow} />],
            ["Runs", t.level === "row" ? "once per row" : "once per statement"],
            ["Calls", <code key="f">{t.function}()</code>],
            ["State", t.state],
          ]}
        />
        <Code text={t.definition} label={`Copy the definition of ${t.name}`} />
      </Item>
    ));
  } else if (kind === "extensions") {
    const items = filterObjects("extensions", objects.extensions, query);
    total = items.length;
    const view = cap(items);
    hidden = view.hidden;
    rows = view.shown.map((e) => (
      <Item
        key={e.name}
        title={e.name}
        badges={<span className="text-xs text-muted-foreground">version {e.version}</span>}
      >
        <Facts
          rows={[
            ["Installed in schema", e.schema],
            ["About", e.comment ?? "(no description)"],
          ]}
        />
        <p className="text-xs text-muted-foreground">
          Functions and types that belong to an extension are not listed separately.
        </p>
      </Item>
    ));
  } else {
    const needle = query.trim().toLowerCase();
    const groups = policyGroups(objects).filter(
      (g) => needle === "" || `${g.schema}.${g.table}`.toLowerCase().includes(needle),
    );
    total = groups.length;
    const view = cap(groups);
    hidden = view.hidden;
    rows = view.shown.map((g) => (
      <Item
        key={`${g.schema}.${g.table}`}
        title={`${g.schema}.${g.table}`}
        badges={
          <>
            <Badge variant={g.enabled ? "secondary" : "outline"}>
              {g.enabled
                ? g.forced
                  ? "row security on, forced"
                  : "row security on"
                : "row security off"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {plural(g.policies.length, "policy", "policies")}
            </span>
            {g.warning ? (
              <AlertTriangle className="size-4 text-destructive" aria-label="Needs attention" />
            ) : null}
          </>
        }
      >
        <p>
          <TableLink schema={g.schema} name={g.table} onShow={onShow} />
        </p>
        {g.warning === "no_policies" ? (
          <p role="note" className="text-sm text-destructive">
            Row security is on but there are no policies, so roles that are not exempt (the table
            owner and superusers are) cannot see or change any row.
          </p>
        ) : null}
        {g.warning === "inactive" ? (
          <p role="note" className="text-sm text-destructive">
            These policies have no effect: row security is not switched on for this table.
          </p>
        ) : null}
        {g.policies.map((p) => (
          <div key={p.name} className="flex flex-col gap-2 rounded-md border p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-medium">{p.name}</span>
              <Badge variant="secondary">{p.command}</Badge>
              <Badge variant="outline">{p.permissive ? "permissive" : "restrictive"}</Badge>
              <span className="text-xs text-muted-foreground">for {p.roles.join(", ")}</span>
            </div>
            <Facts
              rows={[
                ["Rows visible or changeable when", <code key="u">{p.using ?? "(always)"}</code>],
                ...(p.withCheck !== null
                  ? ([
                      ["New or changed rows must satisfy", <code key="w">{p.withCheck}</code>],
                    ] as Array<[string, React.ReactNode]>)
                  : []),
              ]}
            />
          </div>
        ))}
        {g.forced ? (
          <p className="text-xs text-muted-foreground">
            Forced: the table owner is subject to the policies too.
          </p>
        ) : null}
      </Item>
    ));
  }

  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {query.trim() === ""
          ? `This database has no ${OBJECT_LABELS[kind].many.toLowerCase()}.`
          : "Nothing matches the filter."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <List>{rows}</List>
      {hidden > 0 ? (
        <button
          type="button"
          className="self-start text-sm underline underline-offset-2"
          onClick={() => setAll(true)}
        >
          Show the other {hidden}
        </button>
      ) : null}
    </div>
  );
}

function countOf(kind: ObjectKind, objects: DatabaseObjects): number {
  return kind === "policies" ? policyGroups(objects).length : objects[kind].length;
}

export function ObjectsView({ connectionId }: { connectionId: string }) {
  const setView = useWorkspaceStore((s) => s.setView);
  const { state, reload } = useAsyncData(() => getObjects(connectionId), connectionId);
  const [kind, setKind] = useState<ObjectKind>("views");
  const [query, setQuery] = useState("");

  if (state.status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <LoadingState label="Reading views, types, functions…" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <ErrorState
          title="Could not read the objects"
          message={state.error.message}
          onRetry={reload}
        />
      </div>
    );
  }

  const objects = state.data;
  const show = (schema: string, name: string): void => {
    void addTablesToCanvas(connectionId, [{ schema, name }], { focus: true }).then((ok) => {
      if (ok) setView("canvas");
    });
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <header className="flex flex-col gap-1">
        <h2 className="flex flex-wrap items-baseline gap-x-3 text-lg font-semibold">
          Objects
          <span className="text-sm font-normal text-muted-foreground">
            Definitions and settings only. No table rows are read and nothing is changed.
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">
          Functions, types and views that belong to an installed extension are left out; the
          extension itself is listed.
        </p>
      </header>

      <div role="tablist" aria-label="Kind of object" className="flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={`rounded-lg border px-2.5 py-1 text-sm ${
              kind === k ? "bg-secondary font-medium" : "hover:bg-muted"
            }`}
          >
            {OBJECT_LABELS[k].many}{" "}
            <span className="text-muted-foreground">{countOf(k, objects)}</span>
          </button>
        ))}
      </div>

      <Input
        aria-label={`Filter ${OBJECT_LABELS[kind].many.toLowerCase()} by name`}
        placeholder="Filter by name"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {/* `key` resets "show all" when the kind changes. */}
      <Section key={kind} kind={kind} objects={objects} query={query} onShow={show} />
    </div>
  );
}
