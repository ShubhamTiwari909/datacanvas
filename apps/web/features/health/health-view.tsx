/**
 * The "Health" tab: structural hints about the database, grouped by check.
 *
 * Each group explains why the check matters and how to fix it; each finding
 * names the table (a button that shows it on the canvas) and, where a safe
 * statement exists, offers SQL to COPY. DataCanvas never runs it.
 */
"use client";

import { AlertTriangle, Info, ShieldCheck } from "lucide-react";
import { ErrorState } from "@/components/states/error-state";
import { LoadingState } from "@/components/states/loading-state";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/copy-button";
import { addTablesToCanvas } from "@/features/canvas/add-tables";
import { useAsyncData } from "@/lib/use-async-data";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { CHECKS, CHECK_ORDER, type HealthFinding } from "./health-checks";
import { loadHealth, MAX_HEALTH_TABLES } from "./load-health";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function Finding({
  finding,
  onShow,
}: {
  finding: HealthFinding;
  onShow: (schema: string, table: string) => void;
}) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onShow(finding.schema, finding.table)}
          aria-label={`Show ${finding.table} on the canvas`}
          title={`Show ${finding.table} on the canvas`}
          className="rounded font-mono text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2"
        >
          {finding.table}
        </button>
        <span className="text-xs text-muted-foreground">{finding.schema}</span>
        {finding.severity === "info" && finding.check === "foreign_key_without_index" ? (
          <Badge variant="outline">small table</Badge>
        ) : null}
      </div>
      <p className="text-sm">{finding.message}</p>
      {finding.suggestion ? (
        <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1">
          <code className="min-w-0 break-all text-xs">{finding.suggestion}</code>
          <CopyButton text={finding.suggestion} />
        </div>
      ) : null}
    </li>
  );
}

export function HealthView({ connectionId }: { connectionId: string }) {
  const setView = useWorkspaceStore((s) => s.setView);
  const { state, reload } = useAsyncData(() => loadHealth(connectionId), connectionId);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <LoadingState label="Checking the structure…" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <ErrorState
          title="Could not run the checks"
          message={state.error.message}
          onRetry={reload}
        />
      </div>
    );
  }

  const report = state.data;
  const warnings = report.findings.filter((f) => f.severity === "warning").length;
  const notes = report.findings.length - warnings;
  const show = (schema: string, name: string): void => {
    void addTablesToCanvas(connectionId, [{ schema, name }], { focus: true }).then((ok) => {
      if (ok) setView("canvas");
    });
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
      <header className="flex flex-col gap-2">
        <h2 className="flex flex-wrap items-baseline gap-x-3 text-lg font-semibold">
          Health
          <span className="text-sm font-normal text-muted-foreground">
            Hints from the structure and the server&apos;s usage counters. No table rows are read
            and nothing is changed.
          </span>
        </h2>
        <p className="flex flex-wrap items-center gap-3 text-sm">
          <span>Checked {plural(report.checkedTables, "table")}.</span>
          <Badge variant={warnings > 0 ? "destructive" : "secondary"}>
            {plural(warnings, "warning")}
          </Badge>
          <Badge variant="secondary">{plural(notes, "note")}</Badge>
        </p>
        {report.usage ? (
          <p className="text-sm text-muted-foreground">
            Index usage counters{" "}
            {report.usage.statsReset
              ? `since ${new Date(report.usage.statsReset).toLocaleDateString()}`
              : "(the server does not say when they were last reset)"}
            , {plural(report.usage.indexes, "index", "indexes")} read.
          </p>
        ) : null}
        {report.usage?.inRecovery ? (
          <p role="status" className="text-sm text-muted-foreground">
            This server is a standby. Its counters only reflect queries run on it, so an index used
            on the primary can look unused here.
          </p>
        ) : null}
        {report.usageProblem ? (
          <p role="status" className="text-sm text-muted-foreground">
            The unused-index check was skipped: {report.usageProblem}
          </p>
        ) : null}
        {report.skippedTables > 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Only the first {MAX_HEALTH_TABLES} tables were checked; {report.skippedTables} more were
            left out.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Partitions are not checked on their own (their parent table is). Suggested SQL is for you
          to review and run yourself; whether a finding matters depends on how the database is used.
        </p>
      </header>

      {report.findings.length === 0 ? (
        <p className="flex items-center gap-2 text-sm">
          <ShieldCheck className="size-5 text-muted-foreground" aria-hidden="true" />
          Nothing to report for the checks DataCanvas runs.
        </p>
      ) : null}

      {CHECK_ORDER.map((check) => {
        const findings = report.findings.filter((f) => f.check === check);
        if (findings.length === 0) return null;
        const info = CHECKS[check];
        const Icon = info.severity === "warning" ? AlertTriangle : Info;
        const body = (
          <div className="flex flex-col gap-3 pt-2">
            <p className="text-sm text-muted-foreground">{info.why}</p>
            <p className="text-sm">
              <span className="font-medium">How to fix: </span>
              {info.fix}
            </p>
            <ul className="flex flex-col gap-2">
              {findings.map((f) => (
                <Finding key={`${f.schema}.${f.table}.${f.message}`} finding={f} onShow={show} />
              ))}
            </ul>
          </div>
        );
        const heading = (
          <span className="flex items-center gap-2 text-base font-semibold">
            <Icon className="size-4" aria-hidden="true" />
            {info.title}
            <Badge
              variant={findings.some((f) => f.severity === "warning") ? "destructive" : "secondary"}
            >
              {findings.length}
            </Badge>
          </span>
        );
        // Warnings are open; notes are folded away so they do not drown the warnings.
        return info.severity === "warning" ? (
          <section key={check} aria-label={info.title}>
            <h3>{heading}</h3>
            {body}
          </section>
        ) : (
          <details key={check} aria-label={info.title}>
            <summary className="cursor-pointer">{heading}</summary>
            {body}
          </details>
        );
      })}
    </div>
  );
}
