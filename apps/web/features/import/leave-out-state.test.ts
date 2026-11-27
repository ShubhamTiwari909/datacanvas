import type { ValidationReport } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import type { LeaveOutOutcome } from "./leave-out";
import {
  LEAVE_OUT_IDLE,
  currentLeaveOut,
  failedText,
  leaveOutOffered,
  leaveOutReducer,
  progressText,
  readyText,
  refusedText,
  rejectsFileName,
  type LeaveOutState,
} from "./leave-out-state";

const report = (
  failing: number[],
  notChecked: ValidationReport["notChecked"] = [],
): ValidationReport => ({
  rows: 10,
  passed: 10 - failing.length,
  issues:
    failing.length === 0
      ? []
      : [{ rule: "not_null", column: "a", constraint: null, count: failing.length, rows: failing }],
  notChecked,
});

const running = (key = "k", run = 1): LeaveOutState =>
  leaveOutReducer(LEAVE_OUT_IDLE, { type: "start", key, run });

const ready: LeaveOutOutcome = {
  kind: "ready",
  data: { rows: [["x"]], lines: [3] },
  rejects: [
    { line: 2, row: ["bad"], reasons: [{ rule: "not_null", column: "a", constraint: null }] },
  ],
  rounds: 2,
};

describe("leaveOutReducer", () => {
  it("starts at round 0, then follows the rounds of its own run", () => {
    let state = running("k", 1);
    expect(state).toEqual({ status: "running", key: "k", run: 1, round: 0 });
    state = leaveOutReducer(state, { type: "round", run: 1, round: 1 });
    state = leaveOutReducer(state, { type: "round", run: 1, round: 2 });
    expect(state).toMatchObject({ status: "running", round: 2 });
  });

  it("ignores every action of an older run", () => {
    const state = running("k", 2);
    expect(leaveOutReducer(state, { type: "round", run: 1, round: 4 })).toBe(state);
    expect(leaveOutReducer(state, { type: "outcome", run: 1, outcome: ready })).toBe(state);
    expect(leaveOutReducer(state, { type: "failed", run: 1, message: "x" })).toBe(state);
    expect(leaveOutReducer(state, { type: "cancelled", run: 1 })).toBe(state);
  });

  it("ignores an answer once the run is over", () => {
    const done = leaveOutReducer(running(), { type: "outcome", run: 1, outcome: ready });
    expect(leaveOutReducer(done, { type: "cancelled", run: 1 })).toBe(done);
    expect(leaveOutReducer(done, { type: "round", run: 1, round: 3 })).toBe(done);
  });

  it("keeps the rows to import and the rejects of a ready run", () => {
    const state = leaveOutReducer(running("k", 1), { type: "outcome", run: 1, outcome: ready });
    expect(state).toEqual({
      status: "ready",
      key: "k",
      run: 1,
      data: ready.data,
      rejects: ready.rejects,
    });
  });

  it("turns every other outcome into a refusal that leaves nothing out", () => {
    for (const kind of ["rounds_exhausted", "nothing_left", "not_listed"] as const) {
      const state = leaveOutReducer(running(), {
        type: "outcome",
        run: 1,
        outcome: { kind, rejects: [], rounds: 1 },
      });
      expect(state).toEqual({ status: "refused", key: "k", run: 1, refusal: kind });
    }
    expect(
      leaveOutReducer(running(), {
        type: "outcome",
        run: 1,
        outcome: { kind: "too_many", atLeast: 1001, rounds: 1 },
      }),
    ).toMatchObject({ status: "refused", refusal: "too_many" });
  });

  it("goes back to idle when cancelled, and says a failure", () => {
    expect(leaveOutReducer(running(), { type: "cancelled", run: 1 })).toBe(LEAVE_OUT_IDLE);
    expect(leaveOutReducer(running(), { type: "failed", run: 1, message: "Gone." })).toEqual({
      status: "failed",
      key: "k",
      run: 1,
      message: "Gone.",
    });
  });

  it("starts again over any state", () => {
    const done = leaveOutReducer(running("k", 1), { type: "outcome", run: 1, outcome: ready });
    expect(leaveOutReducer(done, { type: "start", key: "j", run: 2 })).toEqual({
      status: "running",
      key: "j",
      run: 2,
      round: 0,
    });
  });
});

describe("currentLeaveOut", () => {
  it("is idle once the choices it was made for change (another file, another mapping)", () => {
    const done = leaveOutReducer(running("file1|map1", 1), {
      type: "outcome",
      run: 1,
      outcome: ready,
    });
    expect(currentLeaveOut(done, "file1|map1")).toBe(done);
    expect(currentLeaveOut(done, "file1|map2")).toBe(LEAVE_OUT_IDLE);
    expect(currentLeaveOut(done, "file2|map1")).toBe(LEAVE_OUT_IDLE);
    expect(currentLeaveOut(LEAVE_OUT_IDLE, "x")).toBe(LEAVE_OUT_IDLE);
  });
});

describe("leaveOutOffered", () => {
  it("is offered after failing rows, never after a clean answer", () => {
    expect(leaveOutOffered(report([2, 3]), false)).toBe(true);
    expect(leaveOutOffered(report([]), false)).toBe(false);
  });

  it("is still offered when the usual validation stopped early, not when a listing of all did", () => {
    expect(leaveOutOffered(report([2], ["stopped_early"]), false)).toBe(true);
    expect(leaveOutOffered(report([2], ["stopped_early"]), true)).toBe(false);
    expect(leaveOutOffered(report([2]), true)).toBe(true);
  });
});

describe("sentences", () => {
  it("say progress, counts and refusals in fixed words", () => {
    expect(progressText(0)).toBe("Checking again, round 1 of 5");
    expect(progressText(3)).toBe("Checking again, round 3 of 5");
    expect(readyText(1, 2_500)).toBe("1 row will not be imported; 2,500 rows will be imported.");
    expect(refusedText("too_many")).toBe("More than 1,000 rows fail: fix the file instead.");
    for (const kind of ["rounds_exhausted", "nothing_left", "not_listed"] as const) {
      expect(refusedText(kind)).toMatch(/no row was left out/);
    }
    expect(failedText("The request was refused.")).toBe(
      "The rows could not be checked again. The request was refused.",
    );
  });
});

describe("rejectsFileName", () => {
  it("drops the extension and adds -rejects.csv", () => {
    expect(rejectsFileName("people.csv")).toBe("people-rejects.csv");
    expect(rejectsFileName("people.2026.tsv")).toBe("people.2026-rejects.csv");
    expect(rejectsFileName("people")).toBe("people-rejects.csv");
    expect(rejectsFileName(".csv")).toBe(".csv-rejects.csv");
    expect(rejectsFileName("")).toBe("import-rejects.csv");
  });
});
