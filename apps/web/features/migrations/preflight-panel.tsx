/**
 * "Check against the data" in the Migrations tab (`docs/advanced-data-workspace-plan.md`, section 6.3):
 * for the steps that can fail on rows that exist, ask the database the migration will run on how many rows
 * would make them fail. Only counts come back; no row is read, kept or shown.
 *
 * It needs the From side to be a live database (that is where the migration meets its data) with table data
 * switched on, because a count says how the data is.
 */
"use client";

import { Loader2, SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConnectionSummary } from "@datacanvas/shared-types";

export function PreflightPanel({
  connection,
  running,
  outcome,
  steps,
  onRun,
}: {
  /** The live database the migration starts from, or undefined when From is a snapshot. */
  connection: ConnectionSummary | undefined;
  running: boolean;
  outcome: { status: "running" } | { status: "error"; message: string } | { status: "done" } | null;
  /** How many steps can fail on rows that exist. */
  steps: number;
  onRun: () => void;
}) {
  let body: React.ReactNode;
  if (!connection) {
    body = (
      <p className="text-sm text-muted-foreground">
        To try these steps against real data, choose a live database as <em>From</em>: that is where
        the migration will run. A snapshot has no rows.
      </p>
    );
  } else if (!connection.dataAccess) {
    body = (
      <p className="text-sm text-muted-foreground">
        Turn on table data for {connection.name} (in its Data section) to check these steps against
        its rows. A count says how the data is, so it needs the same switch as viewing rows.
      </p>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" disabled={running} onClick={onRun}>
          {running ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <SearchCheck aria-hidden="true" />
          )}
          Check against the data
        </Button>
        <p className="text-xs text-muted-foreground">
          Runs read-only counts on {connection.name}. No row is read, kept or shown.
        </p>
      </div>
    );
  }
  return (
    <section aria-labelledby="preflight-heading" className="flex flex-col gap-2">
      <h3 id="preflight-heading" className="text-base font-semibold">
        Will it work on your data?
      </h3>
      <p className="text-xs text-muted-foreground">
        {steps} {steps === 1 ? "step" : "steps"} can fail on rows that exist.
      </p>
      {body}
      <div role="status" aria-live="polite" className="text-sm">
        {outcome?.status === "running" ? <p className="text-muted-foreground">Counting…</p> : null}
        {outcome?.status === "error" ? (
          <p className="text-destructive">The check could not be run. {outcome.message}</p>
        ) : null}
        {outcome?.status === "done" ? (
          <p className="text-muted-foreground">
            Each step below says what was found. A step that is not checked says why.
          </p>
        ) : null}
      </div>
    </section>
  );
}
