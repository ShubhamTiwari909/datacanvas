/**
 * The import dialog's "Leave out the failing rows" (`docs/write-side-v2-plan.md`, section 4.3): the states it goes
 * through and the fixed sentences it shows, as a reducer the dialog runs with `useReducer`. Pure functions, no React.
 *
 * Every state but `idle` belongs to the choices it was made for (`key`: the file, its separator and header, the
 * mapping and the NULL rule): `current` gives `idle` once any of them changes, so a re-pick of the file or a change
 * of the mapping drops what was left out. Each run has a number, and an answer of an older run is ignored. No state
 * or sentence here holds a value of the file: rows left out stay in the browser, for the rejects file only.
 */
import type { ValidationReport } from "@datacanvas/database-core";
import {
  LEAVE_OUT_MAX_ROUNDS,
  LEAVE_OUT_MAX_ROWS,
  type DataRows,
  type LeaveOutOutcome,
  type Reject,
} from "./leave-out";
import { rowsWords } from "./import-plan";

/** An outcome that leaves nothing out. */
export type Refusal = Exclude<LeaveOutOutcome["kind"], "ready">;

export type LeaveOutState =
  | { status: "idle" }
  | { status: "running"; key: string; run: number; round: number }
  | { status: "ready"; key: string; run: number; data: DataRows; rejects: Reject[] }
  | { status: "refused"; key: string; run: number; refusal: Refusal }
  | { status: "failed"; key: string; run: number; message: string };

export type LeaveOutAction =
  | { type: "start"; key: string; run: number }
  | { type: "round"; run: number; round: number }
  | { type: "outcome"; run: number; outcome: LeaveOutOutcome }
  | { type: "failed"; run: number; message: string }
  | { type: "cancelled"; run: number };

export const LEAVE_OUT_IDLE: LeaveOutState = { status: "idle" };

/** The next state. An action of a run that is not the latest is ignored. */
export function leaveOutReducer(state: LeaveOutState, action: LeaveOutAction): LeaveOutState {
  if (action.type === "start") {
    return { status: "running", key: action.key, run: action.run, round: 0 };
  }
  if (state.status !== "running" || state.run !== action.run) return state;
  switch (action.type) {
    case "round":
      return { ...state, round: action.round };
    case "outcome": {
      const { outcome } = action;
      const base = { key: state.key, run: state.run };
      return outcome.kind === "ready"
        ? { status: "ready", ...base, data: outcome.data, rejects: outcome.rejects }
        : { status: "refused", ...base, refusal: outcome.kind };
    }
    case "failed":
      return { status: "failed", key: state.key, run: state.run, message: action.message };
    case "cancelled":
      return LEAVE_OUT_IDLE;
  }
}

/** The state for the choices `key` stands for: `idle` when it was made for others. */
export function currentLeaveOut(state: LeaveOutState, key: string): LeaveOutState {
  return state.status !== "idle" && state.key === key ? state : LEAVE_OUT_IDLE;
}

/**
 * Whether a validation's answer offers to leave the failing rows out: it found failing rows, and it did not say
 * that more than the limit fail in a validation that listed every row (`listedAll`). A validation that stopped at
 * the usual limit still offers it: leaving out validates again, listing all, and decides.
 */
export function leaveOutOffered(report: ValidationReport, listedAll: boolean): boolean {
  return report.issues.length > 0 && !(listedAll && report.notChecked.includes("stopped_early"));
}

/** The progress of a run, said while it checks. */
export function progressText(round: number): string {
  return `Checking again, round ${Math.max(1, round)} of ${LEAVE_OUT_MAX_ROUNDS}`;
}

/** What a run that left rows out says: counts only. */
export function readyText(leftOut: number, kept: number): string {
  return `${rowsWords(leftOut)} will not be imported; ${rowsWords(kept)} will be imported.`;
}

/** What a run that left nothing out says, by its outcome. */
export function refusedText(refusal: Refusal): string {
  switch (refusal) {
    case "too_many":
      return `More than ${LEAVE_OUT_MAX_ROWS.toLocaleString("en-US")} rows fail: fix the file instead.`;
    case "rounds_exhausted":
      return `Each of ${LEAVE_OUT_MAX_ROUNDS} checks found more failing rows, so no row was left out: fix the file instead.`;
    case "nothing_left":
      return "Every row of the file fails, so no row was left out and there is nothing to import.";
    case "not_listed":
      return "The check could not name every failing row, so no row was left out.";
  }
}

/** What a run that could not check says: the fixed message of the request, never a value. */
export function failedText(message: string): string {
  return `The rows could not be checked again. ${message}`;
}

/** The name of the rejects file: the file's name without its extension, then `-rejects.csv`. */
export function rejectsFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem === "" ? "import" : stem}-rejects.csv`;
}
