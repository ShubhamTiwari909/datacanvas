/**
 * The plan on screen: the verdict and counts, the renames to confirm, every step with its risks
 * (leave one out, confirm a destructive one), and the script, the rollback and what was not
 * compared. All of it is computed in the browser from two structures; nothing is saved or sent.
 */
"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import {
  buildScripts,
  isDestructive,
  resolveSelection,
  summarize,
  type MigrationPlan,
  type MigrationStep,
  type RenameSuggestion,
  type Selection,
} from "@datacanvas/database-core";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Legible in both themes: the tinted `destructive` badge is too faint on the light card. */
const DESTRUCTIVE = "border-destructive text-destructive";

const RISK_LABEL = {
  lock: "Locks the table",
  rewrite: "Rewrites the table",
  may_fail: "Can fail on existing rows",
  destructive: "Destroys data",
} as const;

function Risks({ step }: { step: MigrationStep }) {
  const risks = [...new Set(step.risk)];
  return (
    <span className="flex flex-wrap gap-1">
      {risks.map((r) => (
        <Badge key={r} variant="outline" className={r === "destructive" ? DESTRUCTIVE : undefined}>
          {RISK_LABEL[r]}
        </Badge>
      ))}
      {step.reversibility === "data_lost" ? (
        <Badge variant="outline">Rollback cannot restore the data</Badge>
      ) : null}
      {step.reversibility === "none" ? <Badge variant="outline">Cannot be undone</Badge> : null}
      {!step.transactional ? <Badge variant="outline">Cannot run in a transaction</Badge> : null}
    </span>
  );
}

const groupLabel = (s: MigrationStep): string =>
  s.object.of
    ? `${s.object.of} ${s.object.name ?? ""}`.trim()
    : `${s.object.schema}.${s.object.table}`;

function StepRow({
  step,
  included,
  keptBecause,
  confirmed,
  onInclude,
  onConfirm,
}: {
  step: MigrationStep;
  included: boolean;
  /** Set when the step is out only because a step it depends on is. */
  keptBecause: string | undefined;
  confirmed: boolean;
  onInclude: (include: boolean) => void;
  onConfirm: (confirm: boolean) => void;
}) {
  return (
    <li
      className={`flex flex-col gap-1.5 rounded-lg border bg-card p-3 ${included ? "" : "opacity-60"}`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <input
          type="checkbox"
          className="mt-1 size-4"
          checked={included}
          disabled={keptBecause !== undefined}
          aria-label={`Include step ${step.id}: ${step.note}`}
          onChange={(event) => onInclude(event.target.checked)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm">
            <code className="font-mono text-xs text-muted-foreground">{step.id}</code> {step.note}
          </span>
          <Risks step={step} />
          {keptBecause !== undefined ? (
            <span className="text-xs text-muted-foreground">
              Left out with {keptBecause}, which this step needs.
            </span>
          ) : null}
        </div>
      </div>
      {included && isDestructive(step) ? (
        <label className="ml-6 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={confirmed}
            onChange={(event) => onConfirm(event.target.checked)}
          />
          Confirm {step.id}: I know this destroys data. Until then it is written commented out.
        </label>
      ) : null}
      <details className="ml-6 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Show the SQL of {step.id}
        </summary>
        <p className="mt-1 font-medium">Up</p>
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 whitespace-pre-wrap break-words">
          {step.up}
        </pre>
        <p className="mt-1 font-medium">Down</p>
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 whitespace-pre-wrap break-words">
          {step.down ?? "-- none: this step cannot be undone"}
        </pre>
      </details>
    </li>
  );
}

function Renames({
  suggestions,
  confirmed,
  onToggle,
}: {
  suggestions: RenameSuggestion[];
  confirmed: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <section aria-labelledby="renames-heading" className="flex flex-col gap-2">
      <h3 id="renames-heading" className="text-base font-semibold">
        Possible renames ({suggestions.length})
      </h3>
      <p className="text-xs text-muted-foreground">
        A comparison cannot tell a rename from a drop and an add. Confirm only the ones that are
        renames: a rename keeps the rows, a drop and an add does not. Nothing is renamed until you
        confirm it.
      </p>
      <ul className="flex flex-col gap-2">
        {suggestions.map((s) => {
          const blocked = s.requires.some((r) => !confirmed.has(r));
          const what =
            s.kind === "table"
              ? `table ${s.oldName} to ${s.newName}`
              : `${s.kind} ${s.oldName} to ${s.newName} in ${s.table}`;
          return (
            <li key={s.id} className="flex flex-col gap-1 rounded-lg border bg-card p-3">
              <label className="flex flex-wrap items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={confirmed.has(s.id)}
                  disabled={blocked}
                  onChange={(event) => onToggle(s.id, event.target.checked)}
                />
                Rename the {what}
                <Badge variant={s.confidence === "high" ? "secondary" : "outline"}>
                  {s.confidence} confidence
                </Badge>
              </label>
              <ul className="ml-6 list-disc pl-4 text-xs text-muted-foreground">
                {s.evidence.map((line) => (
                  <li key={line}>{line}</li>
                ))}
                {blocked ? <li>Confirm the rename it belongs to first.</li> : null}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type OutputTab = "script" | "rollback" | "notes";

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

export function PlanView({
  plan,
  suggestions,
  confirmedRenames,
  onToggleRename,
  selection,
  onSelection,
  before,
  after,
}: {
  plan: MigrationPlan;
  suggestions: RenameSuggestion[];
  confirmedRenames: ReadonlySet<string>;
  onToggleRename: (id: string, on: boolean) => void;
  selection: Selection;
  onSelection: (next: Selection) => void;
  before: string;
  after: string;
}) {
  const [tab, setTab] = useState<OutputTab>("script");
  const { included, keptTogether } = resolveSelection(plan, selection.leftOut);
  const inSet = new Set(included.map((s) => s.id));
  const summary = summarize(plan, selection);
  const scripts = buildScripts(plan, selection);
  const header = (kind: string) =>
    `-- ${kind} generated by DataCanvas to make ${before.replace(/[\r\n]+/g, " ")} look like ${after.replace(/[\r\n]+/g, " ")}.\n-- Read it before you run it: it contains definitions (views, functions) read from the databases it compares.\n\n`;
  const text =
    tab === "rollback" ? header("Rollback") + scripts.down : header("Migration") + scripts.up;

  const setLeftOut = (id: string, include: boolean) => {
    const next = new Set(selection.leftOut);
    if (include) next.delete(id);
    else next.add(id);
    onSelection({ ...selection, leftOut: next });
  };
  const setConfirmed = (id: string, on: boolean) => {
    const next = new Set(selection.confirmed);
    if (on) next.add(id);
    else next.delete(id);
    onSelection({ ...selection, confirmed: next });
  };

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="summary-heading" className="flex flex-col gap-2">
        <h3 id="summary-heading" className="text-base font-semibold">
          Summary
        </h3>
        {plan.steps.length === 0 ? (
          <p role="status" className="text-sm">
            Nothing to change: <strong>{before}</strong> already looks like <strong>{after}</strong>{" "}
            in everything the migration compares.
          </p>
        ) : (
          <>
            <p role="status" className="text-sm">
              {plural(summary.steps, "step")} to make <strong>{before}</strong> look like{" "}
              <strong>{after}</strong>. Rollback:{" "}
              <strong>
                {summary.reversibility === "full"
                  ? "complete"
                  : summary.reversibility === "partial"
                    ? `partial (${plural(summary.notFullyReversible, "step")} cannot be fully undone)`
                    : "none"}
              </strong>
              .
            </p>
            <div className="flex flex-wrap gap-1">
              {summary.destructive > 0 ? (
                <Badge variant="outline" className={DESTRUCTIVE}>
                  {summary.destructive} destroy data ({summary.unconfirmed} not confirmed)
                </Badge>
              ) : null}
              {summary.byRisk.may_fail > 0 ? (
                <Badge variant="outline">{summary.byRisk.may_fail} can fail</Badge>
              ) : null}
              {summary.byRisk.lock > 0 ? (
                <Badge variant="outline">{summary.byRisk.lock} take a lock</Badge>
              ) : null}
              {summary.byRisk.rewrite > 0 ? (
                <Badge variant="outline">{summary.byRisk.rewrite} rewrite a table</Badge>
              ) : null}
            </div>
          </>
        )}
      </section>

      <Renames suggestions={suggestions} confirmed={confirmedRenames} onToggle={onToggleRename} />

      {plan.steps.length > 0 ? (
        <section aria-labelledby="steps-heading" className="flex flex-col gap-2">
          <h3 id="steps-heading" className="text-base font-semibold">
            Steps ({plan.steps.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            In the order they run. Untick a step to leave it out: the steps that need it go with it.
          </p>
          <ul className="flex flex-col gap-2">
            {plan.steps.map((step, index) => {
              const group = groupLabel(step);
              const previous = plan.steps[index - 1];
              const heading = previous === undefined || groupLabel(previous) !== group;
              return (
                <li key={step.id} className="flex flex-col gap-1.5">
                  {heading ? (
                    <span className="pt-1 font-mono text-xs text-muted-foreground">{group}</span>
                  ) : null}
                  <ul>
                    <StepRow
                      step={step}
                      included={inSet.has(step.id)}
                      keptBecause={keptTogether.get(step.id)}
                      confirmed={selection.confirmed.has(step.id)}
                      onInclude={(include) => setLeftOut(step.id, include)}
                      onConfirm={(on) => setConfirmed(step.id, on)}
                    />
                  </ul>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="output-heading" className="flex flex-col gap-2">
        <h3 id="output-heading" className="text-base font-semibold">
          The text
        </h3>
        <div role="tablist" aria-label="Migration text" className="flex flex-wrap gap-1">
          {(
            [
              ["script", "Script"],
              ["rollback", "Rollback"],
              ["notes", `Notes (${plan.warnings.length + plan.notCompared.length})`],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              variant={tab === value ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTab(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        {tab === "notes" ? (
          <div className="flex flex-col gap-3 text-sm">
            {plan.warnings.length > 0 ? (
              <div>
                <p className="font-medium">Needs a person</p>
                <ul className="list-disc pl-5">
                  {plan.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <p className="font-medium">Not compared, so not in this migration</p>
              <ul className="list-disc pl-5">
                {plan.notCompared.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <CopyButton
                text={text}
                label={tab === "rollback" ? "Copy the rollback" : "Copy the script"}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  download(`${tab === "rollback" ? "rollback" : "migration"}-${stamp()}.sql`, text)
                }
              >
                <Download aria-hidden="true" />
                Download
              </Button>
            </div>
            <pre
              aria-label={tab === "rollback" ? "Rollback" : "Script"}
              tabIndex={0}
              className="max-h-[28rem] overflow-auto rounded-lg border bg-muted p-3 text-xs whitespace-pre-wrap break-words"
            >
              {text}
            </pre>
          </>
        )}
      </section>
    </div>
  );
}
