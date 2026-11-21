/**
 * "Validate" in the row forms: ask the database whether the values would be accepted, without writing
 * anything, and show the answer under the fields (`docs/advanced-data-workspace-plan.md`, section 6.2).
 *
 * The answer belongs to the values it was asked about: when a value changes, it goes away (it is kept with
 * the text of the request it answered, and shown only while that is still the request). It holds rules,
 * names and row numbers, never a value.
 */
"use client";

import { useRef, useState } from "react";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { NOTE_TEXT, describeIssue, type ValidationReport } from "@datacanvas/database-core";
import type { ValidateRequestBody } from "@datacanvas/shared-types";
import { validateRows } from "@/features/data/api";

type Outcome =
  | { status: "loading" }
  | { status: "done"; report: ValidationReport }
  | { status: "error"; message: string };

export interface Validation {
  /** Ask now. */
  run: () => void;
  /** The answer to the CURRENT values, or null when none was asked for. */
  outcome: Outcome | null;
  busy: boolean;
}

export function useValidation(
  connectionId: string,
  request: ValidateRequestBody | null,
): Validation {
  const signature = request ? JSON.stringify(request) : null;
  const [last, setLast] = useState<{ signature: string; outcome: Outcome } | null>(null);
  const latest = useRef(0);
  const run = () => {
    if (!request || signature === null) return;
    const mine = ++latest.current;
    setLast({ signature, outcome: { status: "loading" } });
    void validateRows(connectionId, request).then((result) => {
      if (latest.current !== mine) return;
      setLast({
        signature,
        outcome: result.ok
          ? { status: "done", report: result.data }
          : { status: "error", message: result.error.message },
      });
    });
  };
  const outcome = last && last.signature === signature ? last.outcome : null;
  return { run, outcome, busy: outcome?.status === "loading" };
}

const listRows = (rows: readonly number[], count: number) =>
  `Row${rows.length === 1 ? "" : "s"} ${rows.join(", ")}${count > rows.length ? ` and ${count - rows.length} more` : ""}`;

export function ValidationPanel({ validation }: { validation: Validation }) {
  const { outcome } = validation;
  // A region that is always in the page, so a screen reader announces what appears in it.
  return (
    <div role="status" aria-live="polite" className="text-sm">
      {outcome?.status === "loading" ? (
        <p className="text-muted-foreground">Checking the values with the database…</p>
      ) : null}
      {outcome?.status === "error" ? (
        <p className="text-destructive">The values could not be checked. {outcome.message}</p>
      ) : null}
      {outcome?.status === "done" ? <Report report={outcome.report} /> : null}
    </div>
  );
}

function Report({ report }: { report: ValidationReport }) {
  const clean = report.issues.length === 0;
  const many = report.rows > 1;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-3">
      {clean ? (
        <p className="flex items-center gap-1.5">
          <CheckCircle2
            className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <span>
            No problems found{many ? ` in ${report.rows} rows` : ""}. The database would accept
            {many ? " them" : " this"}.
          </span>
        </p>
      ) : (
        <>
          <p className="flex items-center gap-1.5 font-medium text-destructive">
            <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
            <span>
              {many
                ? `${report.passed} of ${report.rows} rows pass. Problems found:`
                : "The database would refuse this. Problems found:"}
            </span>
          </p>
          <ul className="list-disc pl-6">
            {report.issues.map((issue, i) => (
              <li key={i}>
                {describeIssue(issue)}
                {many ? ` ${listRows(issue.rows, issue.count)}.` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
      {report.notChecked.length > 0 ? (
        <ul className="list-disc pl-6 text-xs text-muted-foreground">
          {report.notChecked.map((note) => (
            <li key={note}>{NOTE_TEXT[note]}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
