/**
 * The "Migrations" tab: pick two sides (a saved snapshot or the live database of any connection),
 * and get the SQL that makes the first look like the second, with its rollback, the risk of every
 * step, and the renames to confirm. Nothing is run: the script is text, built in the browser from
 * the two structures, and nothing about it is saved or sent anywhere.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, FileDiff, Loader2 } from "lucide-react";
import {
  planMigration,
  suggestRenames,
  type DatabaseStructure,
  type Selection,
} from "@datacanvas/database-core";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAsyncData } from "@/lib/use-async-data";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { listSnapshots } from "../snapshots/api";
import { loadSide, sideValue, type CompareSide } from "../snapshots/compare";
import { PlanView } from "./plan-view";

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

type Loaded =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "done";
      from: DatabaseStructure;
      to: DatabaseStructure;
      before: string;
      after: string;
    };

const EMPTY: Selection = { leftOut: new Set(), confirmed: new Set() };

export function MigrationsView({ connectionId }: { connectionId: string }) {
  const connections = useWorkspaceStore((s) => s.connections);
  const seed = useWorkspaceStore((s) => s.migrationSeed);
  const clearSeed = useWorkspaceStore((s) => s.clearMigrationSeed);
  const { state, reload } = useAsyncData(() => listSnapshots(), connectionId);

  const [fromChoice, setFromChoice] = useState<string | null>(seed?.before ?? null);
  const [toChoice, setToChoice] = useState<string | null>(seed?.after ?? null);
  const [loaded, setLoaded] = useState<Loaded>({ status: "idle" });
  const [concurrentIndexes, setConcurrentIndexes] = useState(false);
  const [safeConstraints, setSafeConstraints] = useState(false);
  const [renames, setRenames] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<Selection>(EMPTY);
  const run = useRef(0);
  const started = useRef(false);

  const snapshots = state.status === "success" ? state.data : [];
  const options: CompareSide[] = [
    ...snapshots.map((s): CompareSide => ({ kind: "snapshot", id: s.id, label: s.name })),
    ...connections.map((c): CompareSide => ({
      kind: "live",
      connectionId: c.id,
      label: `Live: ${c.name} (${c.database})`,
    })),
  ];
  const byValue = new Map(options.map((o) => [sideValue(o), o]));
  const here = sideValue({ kind: "live", connectionId, label: "" });
  const from = fromChoice && byValue.has(fromChoice) ? fromChoice : null;
  const to = toChoice && byValue.has(toChoice) ? toChoice : byValue.has(here) ? here : null;
  const fromSide = from ? byValue.get(from) : undefined;
  const toSide = to ? byValue.get(to) : undefined;

  const build = async (a: CompareSide | undefined, b: CompareSide | undefined): Promise<void> => {
    if (!a || !b) return;
    const mine = ++run.current;
    setLoaded({ status: "loading" });
    setRenames(new Set());
    setSelection(EMPTY);
    const [x, y] = await Promise.all([loadSide(a), loadSide(b)]);
    if (mine !== run.current) return;
    if (!x.ok) return setLoaded({ status: "error", message: x.error.message });
    if (!y.ok) return setLoaded({ status: "error", message: y.error.message });
    setLoaded({ status: "done", from: x.data, to: y.data, before: a.label, after: b.label });
  };

  // Arriving from a comparison: build its plan once the choices exist.
  useEffect(() => {
    if (started.current || seed === null || state.status !== "success") return;
    started.current = true;
    const a = byValue.get(seed.before);
    const b = byValue.get(seed.after);
    clearSeed();
    void build(a, b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, state.status]);

  const suggestions = useMemo(
    () => (loaded.status === "done" ? suggestRenames(loaded.from, loaded.to) : []),
    [loaded],
  );
  const plan = useMemo(
    () =>
      loaded.status === "done"
        ? planMigration(loaded.from, loaded.to, {
            concurrentIndexes,
            safeConstraints,
            renames: [...renames],
          })
        : null,
    [loaded, concurrentIndexes, safeConstraints, renames],
  );

  if (state.status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <LoadingState label="Loading…" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <ErrorState
          title="Could not load snapshots"
          message={state.error.message}
          onRetry={reload}
        />
      </div>
    );
  }

  // Changing what the plan is made of renumbers its steps, so what was picked starts again.
  const changePlan = (action: () => void) => {
    action();
    setSelection(EMPTY);
  };

  const sidePicker = (
    id: string,
    label: string,
    value: string | null,
    set: (v: string) => void,
  ) => (
    <div className="flex min-w-48 flex-1 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value ?? ""}
        onChange={(event) => set(event.target.value)}
      >
        <option value="" disabled>
          Choose…
        </option>
        {options.map((o) => (
          <option key={sideValue(o)} value={sideValue(o)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
      <header className="flex flex-col gap-1">
        <h2 className="flex flex-wrap items-baseline gap-x-3 text-lg font-semibold">
          Migrations
          <span className="text-sm font-normal text-muted-foreground">
            Make one database look like another, with the rollback and the risks.
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">
          This writes SQL and never runs it. It is built in your browser from the structure of the
          two sides and nothing about it is saved. It copies view queries and function bodies from
          the databases it reads: read the script before you run it anywhere.
        </p>
      </header>

      <section aria-labelledby="sides-heading" className="flex flex-col gap-3">
        <h3 id="sides-heading" className="text-base font-semibold">
          Make <em>From</em> look like <em>To</em>
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          {sidePicker("migration-from", "From", from, setFromChoice)}
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Swap From and To"
            disabled={!from || !to}
            onClick={() => {
              setFromChoice(to);
              setToChoice(from);
            }}
          >
            <ArrowLeftRight aria-hidden="true" />
          </Button>
          {sidePicker("migration-to", "To", to, setToChoice)}
          <Button
            type="button"
            disabled={!fromSide || !toSide || loaded.status === "loading"}
            onClick={() => void build(fromSide, toSide)}
          >
            {loaded.status === "loading" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <FileDiff aria-hidden="true" />
            )}
            Generate migration
          </Button>
        </div>
        <fieldset className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <legend className="sr-only">Options</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4"
              checked={concurrentIndexes}
              onChange={(e) => changePlan(() => setConcurrentIndexes(e.target.checked))}
            />
            Create indexes without blocking writes (not inside a transaction)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4"
              checked={safeConstraints}
              onChange={(e) => changePlan(() => setSafeConstraints(e.target.checked))}
            />
            Add checks and foreign keys unvalidated, then validate
          </label>
        </fieldset>
      </section>

      {loaded.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {loaded.message}
        </p>
      ) : null}
      {loaded.status === "done" && plan ? (
        <PlanView
          plan={plan}
          suggestions={suggestions}
          confirmedRenames={renames}
          onToggleRename={(id, on) =>
            changePlan(() => {
              const next = new Set(renames);
              if (on) next.add(id);
              else {
                next.delete(id);
                // A rename that waited for this one cannot stand without it.
                for (const s of suggestions) if (s.requires.includes(id)) next.delete(s.id);
              }
              setRenames(next);
            })
          }
          selection={selection}
          onSelection={setSelection}
          before={loaded.before}
          after={loaded.after}
        />
      ) : null}
    </div>
  );
}
