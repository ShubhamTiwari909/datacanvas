/**
 * The "Snapshots" tab: save the database's structure now, compare it later with
 * the live database or with another snapshot (a snapshot of a different
 * database works too), and export / import snapshot files.
 *
 * A snapshot holds structure only: names, types, keys, indexes. It never
 * contains rows, whether or not data viewing is on, and no credentials. The
 * server reads the database; this screen only asks for it.
 */
"use client";

import { useRef, useState } from "react";
import { Camera, FileDown, FileUp, GitCompare, Loader2, Trash2 } from "lucide-react";
import type { SnapshotSummary } from "@datacanvas/shared-types";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAsyncData } from "@/lib/use-async-data";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  createSnapshot,
  deleteSnapshot,
  importSnapshot,
  listSnapshots,
  snapshotExportUrl,
} from "./api";
import { compareSides, sideValue, type CompareSide, type Comparison } from "./compare";
import { DiffView } from "./diff-view";

/** Same ceiling as the server's import limit. */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

type Notice = { tone: "ok" | "error"; text: string } | null;
type CompareState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; comparison: Comparison };

function SnapshotRow({
  snapshot,
  onDelete,
  disabled,
}: {
  snapshot: SnapshotSummary;
  onDelete: (id: string) => void;
  disabled: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{snapshot.name}</span>
        <span className="text-xs text-muted-foreground">
          {formatDate(snapshot.createdAt)}
          {snapshot.source ? ` · ${snapshot.source.database}` : ""} ·{" "}
          {plural(snapshot.counts.tables, "table")},{" "}
          {plural(snapshot.counts.relationships, "foreign key")},{" "}
          {snapshot.counts.objects === null
            ? "objects not recorded"
            : plural(snapshot.counts.objects, "other object")}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <Button asChild variant="ghost" size="sm">
          <a href={snapshotExportUrl(snapshot.id)} download aria-label={`Export ${snapshot.name}`}>
            <FileDown aria-hidden="true" />
            Export
          </a>
        </Button>
        {confirming ? (
          <>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={() => onDelete(snapshot.id)}
              aria-label={`Confirm deleting ${snapshot.name}`}
            >
              Delete for good
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${snapshot.name}`}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export function SnapshotsView({ connectionId }: { connectionId: string }) {
  const connections = useWorkspaceStore((s) => s.connections);
  const { state, reload } = useAsyncData(() => listSnapshots(), connectionId);

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [beforeChoice, setBeforeChoice] = useState<string | null>(null);
  const [afterChoice, setAfterChoice] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareState>({ status: "idle" });
  // Only the newest comparison may show its result (a slow older one is ignored).
  const compareRun = useRef(0);
  // Which two sides the comparison on screen (or still loading) is about.
  const comparedSides = useRef<string[]>([]);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <LoadingState label="Loading snapshots…" />
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

  const snapshots = state.data;
  const current = connections.find((c) => c.id === connectionId);

  // Every option a side can be: each saved snapshot, and the live database of each connection.
  const options: CompareSide[] = [
    ...snapshots.map((s): CompareSide => ({ kind: "snapshot", id: s.id, label: s.name })),
    ...connections.map((c): CompareSide => ({
      kind: "live",
      connectionId: c.id,
      label: `Live: ${c.name} (${c.database})`,
    })),
  ];
  const byValue = new Map(options.map((o) => [sideValue(o), o]));
  const liveHere = current ? sideValue({ kind: "live", connectionId, label: "" }) : null;
  const defaultBefore = snapshots[0] ? `snapshot:${snapshots[0].id}` : null;
  // A stored choice that no longer exists (a deleted snapshot) falls back to the default.
  const before = beforeChoice && byValue.has(beforeChoice) ? beforeChoice : defaultBefore;
  const after = afterChoice && byValue.has(afterChoice) ? afterChoice : liveHere;
  const beforeSide = before ? byValue.get(before) : undefined;
  const afterSide = after ? byValue.get(after) : undefined;

  const run = async (action: () => Promise<string | null>, success: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    const problem = await action();
    setBusy(false);
    if (problem === null) {
      setNotice({ tone: "ok", text: success });
      reload();
    } else {
      setNotice({ tone: "error", text: problem });
    }
  };

  const take = (): Promise<void> =>
    run(async () => {
      const trimmed = name.trim();
      const result = await createSnapshot(connectionId, trimmed === "" ? {} : { name: trimmed });
      if (!result.ok) return result.error.message;
      setName("");
      return null;
    }, "Snapshot saved.");

  const remove = (id: string): Promise<void> =>
    run(async () => {
      const result = await deleteSnapshot(id);
      if (!result.ok) return result.error.message;
      // A comparison that used this snapshot would show a result nobody can reproduce:
      // clear it, and make sure a slow one still in flight cannot appear afterwards.
      if (comparedSides.current.includes(`snapshot:${id}`)) {
        compareRun.current += 1;
        comparedSides.current = [];
        setCompare({ status: "idle" });
      }
      return null;
    }, "Snapshot deleted.");

  const importFile = (file: File): Promise<void> =>
    run(async () => {
      if (file.size > MAX_IMPORT_BYTES)
        return "This file is too large to be a DataCanvas snapshot.";
      let content: unknown;
      try {
        content = JSON.parse(await file.text());
      } catch {
        return "This file is not valid JSON, so it is not a DataCanvas snapshot.";
      }
      const result = await importSnapshot(content);
      return result.ok ? null : result.error.message;
    }, "Snapshot imported.");

  const runCompare = async (): Promise<void> => {
    if (!beforeSide || !afterSide) return;
    const mine = ++compareRun.current;
    comparedSides.current = [sideValue(beforeSide), sideValue(afterSide)];
    setCompare({ status: "loading" });
    const result = await compareSides(beforeSide, afterSide);
    if (mine !== compareRun.current) return;
    setCompare(
      result.ok
        ? { status: "done", comparison: result.data }
        : { status: "error", message: result.error.message },
    );
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 p-4">
      <header className="flex flex-col gap-1">
        <h2 className="flex flex-wrap items-baseline gap-x-3 text-lg font-semibold">
          Snapshots
          <span className="text-sm font-normal text-muted-foreground">
            Save the structure now, compare it later. A snapshot never holds table rows or
            connection credentials.
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">
          Snapshot files list table and column names, and copy view queries and function bodies as
          they are written, so they can contain anything someone typed into them, even a key or a
          password. Treat an exported file like the schema itself, and look before you share it. A
          snapshot is read in several steps, so one taken while a migration runs can mix before and
          after.
        </p>
      </header>

      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={
            notice.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
          }
        >
          {notice.text}
        </p>
      ) : null}

      <section aria-labelledby="take-heading" className="flex flex-col gap-3">
        <h3 id="take-heading" className="text-base font-semibold">
          Save a snapshot of {current ? current.database : "this database"}
        </h3>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void take();
          }}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="snapshot-name">Name (optional)</Label>
            <Input
              id="snapshot-name"
              value={name}
              maxLength={100}
              placeholder="Before the orders migration"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Camera aria-hidden="true" />
            )}
            Take snapshot
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp aria-hidden="true" />
            Import file
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            aria-label="Import a snapshot file"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = ""; // allow choosing the same file again later
              if (file) void importFile(file);
            }}
          />
        </form>
      </section>

      <section aria-labelledby="saved-heading" className="flex flex-col gap-3">
        <h3 id="saved-heading" className="text-base font-semibold">
          Saved snapshots ({snapshots.length})
        </h3>
        {snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing saved yet. Take a snapshot to have something to compare against later.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {snapshots.map((s) => (
              <SnapshotRow
                key={s.id}
                snapshot={s}
                onDelete={(id) => void remove(id)}
                disabled={busy}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="compare-heading" className="flex flex-col gap-3">
        <h3 id="compare-heading" className="text-base font-semibold">
          Compare
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="compare-before">Before</Label>
            <select
              id="compare-before"
              className={SELECT_CLASS}
              value={before ?? ""}
              onChange={(event) => setBeforeChoice(event.target.value)}
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
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="compare-after">After</Label>
            <select
              id="compare-after"
              className={SELECT_CLASS}
              value={after ?? ""}
              onChange={(event) => setAfterChoice(event.target.value)}
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
          <Button
            type="button"
            disabled={!beforeSide || !afterSide || compare.status === "loading"}
            onClick={() => void runCompare()}
          >
            {compare.status === "loading" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <GitCompare aria-hidden="true" />
            )}
            Compare
          </Button>
        </div>
        {options.length > 0 && snapshots.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            You can already compare two live databases; save a snapshot to compare against the past.
          </p>
        ) : null}

        {compare.status === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {compare.message}
          </p>
        ) : null}
        {compare.status === "done" ? (
          <DiffView
            diff={compare.comparison.diff}
            before={compare.comparison.before}
            after={compare.comparison.after}
          />
        ) : null}
      </section>
    </div>
  );
}
