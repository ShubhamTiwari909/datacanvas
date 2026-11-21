/**
 * What the pre-flight found, laid out per step (`docs/advanced-data-workspace-plan.md`, section 6.3):
 * the checks of every step are sent together, and the answers (counts) are put back with the step they
 * were for. Pure functions, no React.
 */
import {
  NOT_CHECKABLE,
  PREFLIGHT_MAX_CHECKS,
  describePreflight,
  preflightVerdict,
  type PlannedChecks,
  type PreflightCheck,
  type PreflightResult,
} from "@datacanvas/database-core";

export interface StepFinding {
  verdict: "ok" | "fails" | "partly" | "unchecked";
  /** Fixed sentences with a number and a name in them, never a value. */
  lines: string[];
}

/** Every check of every step, in the order of the steps. */
export function flattenChecks(planned: readonly PlannedChecks[]): PreflightCheck[] {
  return planned.flatMap((p) => p.checks);
}

/** The checks in requests of at most `PREFLIGHT_MAX_CHECKS`. */
export function inRequests(checks: readonly PreflightCheck[]): PreflightCheck[][] {
  const out: PreflightCheck[][] = [];
  for (let i = 0; i < checks.length; i += PREFLIGHT_MAX_CHECKS) {
    out.push(checks.slice(i, i + PREFLIGHT_MAX_CHECKS));
  }
  return out;
}

/** The answers to `flattenChecks(planned)`, in the same order, put back with their steps. */
export function findingsFor(
  planned: readonly PlannedChecks[],
  results: readonly PreflightResult[],
): Map<string, StepFinding> {
  const out = new Map<string, StepFinding>();
  let at = 0;
  for (const step of planned) {
    if (step.checks.length === 0) {
      out.set(step.stepId, {
        verdict: "unchecked",
        lines: [NOT_CHECKABLE[step.unchecked ?? "other"]],
      });
      continue;
    }
    const mine = step.checks.map((check, i) => ({
      check,
      result: results[at + i] ?? ({ status: "missing", count: 0 } as PreflightResult),
    }));
    at += step.checks.length;
    out.set(step.stepId, {
      verdict: preflightVerdict(mine.map((m) => m.result)),
      lines: mine.map((m) => describePreflight(m.check, m.result)),
    });
  }
  return out;
}
