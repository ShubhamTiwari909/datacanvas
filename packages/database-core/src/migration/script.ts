/**
 * From a plan to the text a person reads and copies: which steps are in (the person may leave a
 * change out, and what depends on it goes with it), which destructive steps are confirmed (the
 * rest are written commented out), and the script and rollback.
 *
 * Every line of text that is not SQL goes through `flattenComment` (names can hold line breaks,
 * and PostgreSQL ends a `--` comment at a carriage return as well as at a line feed), and commented
 * out SQL is cut at every kind of line break, so no part of a held step can run.
 */
import type { MigrationPlan, MigrationStep, Reversibility, Risk } from "./types.js";

export interface Selection {
  /** Step ids the person left out. What depends on them is left out too. */
  leftOut: ReadonlySet<string>;
  /** Ids of destructive steps the person confirmed; the others are written commented out. */
  confirmed: ReadonlySet<string>;
}

export interface Resolved {
  /** The steps that are in, in order. */
  included: MigrationStep[];
  /** A step left out only because one it depends on is: its id and the id it waits for. */
  keptTogether: Map<string, string>;
}

/** One physical line of text: line breaks of every kind become spaces. */
export const flattenComment = (text: string): string => text.replace(/[\r\n\u2028\u2029]+/g, " ");

/** SQL written as comments: each line starts with `-- `, cut at `\r` and `\n` alike. */
export const commentOut = (sql: string): string =>
  sql
    .split(/\r\n|\r|\n/)
    .map((line) => `-- ${line}`)
    .join("\n");

export const isDestructive = (step: MigrationStep): boolean => step.risk.includes("destructive");

/** The steps that are in, given what the person left out. */
export function resolveSelection(plan: MigrationPlan, leftOut: ReadonlySet<string>): Resolved {
  const out = new Set(leftOut);
  const keptTogether = new Map<string, string>();
  // Steps are in order and depend only on earlier ones, so one pass is enough.
  for (const step of plan.steps) {
    if (out.has(step.id)) continue;
    const gone = step.dependsOn.find((id) => out.has(id));
    if (gone !== undefined) {
      out.add(step.id);
      keptTogether.set(step.id, keptTogether.get(gone) ?? gone);
    }
  }
  return { included: plan.steps.filter((s) => !out.has(s.id)), keptTogether };
}

export interface Scripts {
  up: string;
  down: string;
  /** Ids of destructive steps written commented out. */
  held: string[];
}

export function buildScripts(plan: MigrationPlan, selection: Selection): Scripts {
  const { included } = resolveSelection(plan, selection.leftOut);
  const held = included
    .filter((s) => isDestructive(s) && !selection.confirmed.has(s.id))
    .map((s) => s.id);
  const heldSet = new Set(held);
  const up = included
    .map((s) => {
      const header = `-- ${s.id}: ${flattenComment(s.note)}`;
      return heldSet.has(s.id)
        ? `${header}\n-- NOT CONFIRMED (destroys data): confirm this step to run it.\n${commentOut(s.up)}`
        : `${header}\n${s.up}`;
    })
    .join("\n\n");
  const down = [...included]
    .reverse()
    .map((s) => {
      const header = `-- undo ${s.id}: ${flattenComment(s.note)}`;
      if (s.down === null) return `${header}\n-- This step cannot be undone.`;
      return heldSet.has(s.id) ? `${header}\n${commentOut(s.down)}` : `${header}\n${s.down}`;
    })
    .join("\n\n");
  return { up, down, held };
}

export interface Summary {
  steps: number;
  byRisk: Record<Risk, number>;
  /** Steps that cannot be undone, or lose data when undone. */
  notFullyReversible: number;
  reversibility: "full" | "partial" | "none";
  destructive: number;
  unconfirmed: number;
}

export function summarize(plan: MigrationPlan, selection: Selection): Summary {
  const { included } = resolveSelection(plan, selection.leftOut);
  const byRisk: Record<Risk, number> = { lock: 0, rewrite: 0, may_fail: 0, destructive: 0 };
  for (const s of included) for (const r of new Set(s.risk)) byRisk[r] += 1;
  const level = (r: Reversibility) => r;
  const notFull = included.filter((s) => level(s.reversibility) !== "full").length;
  return {
    steps: included.length,
    byRisk,
    notFullyReversible: notFull,
    reversibility:
      included.length === 0 || notFull === 0
        ? "full"
        : included.every((s) => s.reversibility === "none")
          ? "none"
          : "partial",
    destructive: byRisk.destructive,
    unconfirmed: included.filter((s) => isDestructive(s) && !selection.confirmed.has(s.id)).length,
  };
}
