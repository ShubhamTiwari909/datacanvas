/**
 * The plan of a statement as a tree (`docs/insight-release-plan.md`, section 5; decision 164): each step with its
 * cost, the rows the planner expected against the rows it got, its time and its buffers, and in words what deserves
 * the eye. A switch shows the JSON as it came, which is what people paste into a chat.
 *
 * It holds a plan only in the memory of the tab, like a result. The conditions can hold a literal of the person's own
 * statement, so the Blur switch hides them.
 */
"use client";

import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { BLUR_CLASSES, useBlurStore } from "@/features/data/blur-store";
import { cn } from "@/lib/utils";
import { planFromRows, type ParsedPlan, type PlanMark, type PlanNode } from "./plan";

const fmt = (value: number, digits = 2): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: digits });
const ms = (value: number): string => `${fmt(value)} ms`;

export function markWords(mark: PlanMark): string {
  switch (mark.kind) {
    case "misestimate":
      return `The planner expected ${fmt(mark.expected, 0)} rows and got ${fmt(mark.actual, 0)}: ${fmt(mark.ratio, 0)} times off.`;
    case "seq_scan_large":
      return `Reads every row of a table the planner thinks has about ${fmt(mark.rows, 0)} rows.`;
    case "spill":
      return `The ${mark.what} did not fit in memory and used the disk.`;
    case "most_time":
      return `${mark.share}% of the time of the whole plan is spent in this step itself.`;
  }
}

function headline(node: PlanNode): string {
  const parts = [node.type];
  if (node.joinType) parts.push(`(${node.joinType})`);
  if (node.strategy) parts.push(`(${node.strategy})`);
  if (node.target) parts.push(`on ${node.target}`);
  if (node.index) parts.push(`using ${node.index}`);
  return parts.join(" ");
}

function numbers(node: PlanNode, analyzed: boolean): string[] {
  const out: string[] = [];
  if (node.costTotal !== null) {
    out.push(
      node.costStart !== null
        ? `cost ${fmt(node.costStart)} to ${fmt(node.costTotal)}`
        : `cost ${fmt(node.costTotal)}`,
    );
  }
  if (node.expectedRows !== null) {
    out.push(
      analyzed && node.actualRows !== null
        ? `rows ${fmt(node.expectedRows, 0)} expected, ${fmt(node.actualRows, 0)} got${node.loops && node.loops > 1 ? ` × ${fmt(node.loops, 0)} runs` : ""}`
        : `rows ${fmt(node.expectedRows, 0)} expected`,
    );
  }
  if (analyzed && node.totalMs !== null) {
    out.push(
      node.selfMs !== null && node.children.length > 0
        ? `${ms(node.totalMs)} in all, ${ms(node.selfMs)} in this step`
        : ms(node.totalMs),
    );
  }
  if (node.sharedHit !== null || node.sharedRead !== null) {
    out.push(
      `buffers ${fmt(node.sharedHit ?? 0, 0)} in memory, ${fmt(node.sharedRead ?? 0, 0)} read`,
    );
  }
  return out;
}

function Step({
  node,
  analyzed,
  depth,
  openAll,
  blurred,
}: {
  node: PlanNode;
  analyzed: boolean;
  depth: number;
  openAll: boolean;
  blurred: boolean;
}) {
  const [open, setOpen] = useState(openAll || depth < 4);
  const body = (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{numbers(node, analyzed).join(" · ")}</span>
      {node.conditions.map((c) => (
        <span key={c.label + c.text} className="font-mono text-xs break-words">
          <span className="font-sans text-muted-foreground">{c.label}: </span>
          <span className={cn(blurred && BLUR_CLASSES)}>{c.text}</span>
        </span>
      ))}
      {node.marks.map((m, i) => (
        <span
          key={i}
          className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs"
        >
          <AlertTriangle
            className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          {markWords(m)}
        </span>
      ))}
    </div>
  );
  if (node.children.length === 0) {
    return (
      <li className="rounded-md border p-2">
        <p className="font-medium">{headline(node)}</p>
        {body}
      </li>
    );
  }
  return (
    <li className="rounded-md border p-2">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer font-medium">{headline(node)}</summary>
        <div className="mt-1 flex flex-col gap-2">
          {body}
          {/* The steps below are drawn only while this one is open: a plan of 20,000 steps is not 20,000 elements. */}
          {open ? (
            <ul className="ml-3 flex flex-col gap-2 border-l pl-3">
              {node.children.map((child, i) => (
                <Step
                  key={i}
                  node={child}
                  analyzed={analyzed}
                  depth={depth + 1}
                  openAll={openAll}
                  blurred={blurred}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </li>
  );
}

function Summary({ plan }: { plan: ParsedPlan }) {
  const parts = [`${plan.nodeCount} ${plan.nodeCount === 1 ? "step" : "steps"}`];
  if (plan.planningMs !== null) parts.push(`planning ${ms(plan.planningMs)}`);
  if (plan.executionMs !== null) parts.push(`execution ${ms(plan.executionMs)}`);
  if (!plan.analyzed) parts.push("not run: the numbers are the planner's guesses");
  return <p className="text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}

/** What a plan result shows: the tree (or the reason it is not one) and a switch to the text as it came. */
export function PlanResultView({
  rows,
  fallbackText,
}: {
  rows: ReadonlyArray<ReadonlyArray<string | null>>;
  fallbackText: string;
}) {
  const parsed = useMemo(() => planFromRows(rows), [rows]);
  const [shown, setShown] = useState<"tree" | "text">("tree");
  const blurred = useBlurStore((s) => s.blurred);
  const text = (
    <pre
      tabIndex={0}
      aria-label="Query plan"
      className="h-full overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre"
    >
      {fallbackText}
    </pre>
  );
  // A plan in the text format (many rows), or one that cannot be read as a tree: the text as it came.
  if (parsed === null) return text;
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="How to show the plan" className="flex gap-1">
          {(["tree", "text"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={shown === kind}
              onClick={() => setShown(kind)}
              className={cn(
                "rounded-md border px-2 py-1 text-xs font-medium",
                shown === kind
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "bg-background",
              )}
            >
              {kind === "tree" ? "Tree" : "JSON text"}
            </button>
          ))}
        </div>
        {parsed.ok ? <Summary plan={parsed.plan} /> : null}
        <CopyButton text={fallbackText} label="Copy the plan" />
      </div>
      {!parsed.ok ? (
        <p role="status" className="text-sm text-muted-foreground">
          {parsed.reason} The text is shown as it came.
        </p>
      ) : null}
      {shown === "text" || !parsed.ok ? (
        text
      ) : (
        <div
          tabIndex={0}
          aria-label="Query plan as a tree"
          className="min-h-0 flex-1 overflow-auto"
        >
          <ul className="flex flex-col gap-2">
            <Step
              node={parsed.plan.root}
              analyzed={parsed.plan.analyzed}
              depth={1}
              openAll={parsed.plan.nodeCount <= 300}
              blurred={blurred}
            />
          </ul>
        </div>
      )}
    </div>
  );
}
