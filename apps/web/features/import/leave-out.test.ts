import type { ValidationIssue, ValidationReport } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv-parse";
import { buildImport } from "./import-plan";
import {
  dataRowsWithLines,
  failingRowsOf,
  LEAVE_OUT_MAX_ROUNDS,
  LEAVE_OUT_MAX_ROWS,
  leaveOutRows,
  lineOfRequestRow,
  planLeaveOut,
  type DataRows,
  type ValidateRows,
} from "./leave-out";

const parsed = (text: string) => {
  const p = parseCsv(text, ",");
  if (!p.ok) throw new Error(p.refusal);
  return p;
};

// Lines: 1 header, 2 a, 3 blank, 4 b (a value over two lines), 6 c, 7 d.
const FILE = 'id,name\n1,a\n\n2,"b\nb"\n3,c\n4,d\n';

const issue = (
  rule: ValidationIssue["rule"],
  rows: number[],
  extra: Partial<ValidationIssue> = {},
): ValidationIssue => ({
  rule,
  column: null,
  constraint: null,
  count: rows.length,
  rows,
  ...extra,
});

const report = (
  rows: number,
  issues: ValidationIssue[] = [],
  stopped = false,
): ValidationReport => ({
  rows,
  passed: rows - new Set(issues.flatMap((i) => i.rows)).size,
  issues,
  notChecked: stopped ? ["stopped_early"] : [],
});

describe("dataRowsWithLines and lineOfRequestRow", () => {
  it("pairs each data row with the file line it starts on, below the header", () => {
    const data = dataRowsWithLines(parsed(FILE), true);
    expect(data.rows).toEqual([
      ["1", "a"],
      ["2", "b\nb"],
      ["3", "c"],
      ["4", "d"],
    ]);
    expect(data.lines).toEqual([2, 4, 6, 7]);
    // Row n of the request is the n-th data row: the same line the dialog shows today.
    expect(lineOfRequestRow(data, 1)).toBe(2);
    expect(lineOfRequestRow(data, 3)).toBe(6);
  });

  it("keeps the first row when it is data", () => {
    const data = dataRowsWithLines(parsed("1,a\n2,b\n"), false);
    expect(data.lines).toEqual([1, 2]);
  });

  it("numbers the rows as the request built from the same file does", () => {
    const p = parsed(FILE);
    const change = buildImport(
      { schema: "s", name: "t" },
      {
        rows: p.rows,
        header: true,
        mapping: ["id", "name"],
        rule: { emptyIsNull: true, words: [] },
      },
    );
    const data = dataRowsWithLines(p, true);
    change.rows.forEach((row, i) => expect(row).toEqual(data.rows[i]));
  });

  it("refuses a row number outside the rows sent", () => {
    const data = dataRowsWithLines(parsed(FILE), true);
    expect(() => lineOfRequestRow(data, 0)).toThrow(RangeError);
    expect(() => lineOfRequestRow(data, 5)).toThrow(RangeError);
    expect(() => lineOfRequestRow(data, 1.5)).toThrow(RangeError);
  });
});

describe("leaveOutRows", () => {
  const data = dataRowsWithLines(parsed(FILE), true);

  it("removes the rows named (1-based among the rows sent) and keeps the lines of the rest", () => {
    const rest = leaveOutRows(data, [2, 4, 2]);
    expect(rest.rows).toEqual([
      ["1", "a"],
      ["3", "c"],
    ]);
    expect(rest.lines).toEqual([2, 6]);
  });

  it("numbers the next round among the rows that remain", () => {
    const rest = leaveOutRows(data, [1]);
    // Row 1 of the next request is the old row 2, on line 4.
    expect(lineOfRequestRow(rest, 1)).toBe(4);
    const again = leaveOutRows(rest, [2]);
    expect(again.lines).toEqual([4, 7]);
  });

  it("does not change the rows it was given", () => {
    leaveOutRows(data, [1, 2, 3, 4]);
    expect(data.rows.length).toBe(4);
    expect(leaveOutRows(data, []).rows).toEqual(data.rows);
  });

  it("throws on a number outside the rows sent", () => {
    expect(() => leaveOutRows(data, [5])).toThrow(RangeError);
  });
});

describe("failingRowsOf", () => {
  it("lists each row once with every reason named for it, in row order", () => {
    const rows = failingRowsOf(
      report(5, [
        issue("not_null", [3, 1], { column: "qty" }),
        issue("check", [3], { constraint: "c" }),
        issue("not_null", [3], { column: "qty" }),
      ]),
    );
    expect([...rows.keys()]).toEqual([1, 3]);
    expect(rows.get(3)).toEqual([
      { rule: "not_null", column: "qty", constraint: null },
      { rule: "check", column: null, constraint: "c" },
    ]);
  });
});

describe("planLeaveOut", () => {
  const start = (): DataRows => dataRowsWithLines(parsed(FILE), true);
  const never = new AbortController().signal;

  /** A fake validation: a row fails when its name is listed; the batch is checked as the server would number it. */
  const byName = (
    rounds: Array<Record<string, ValidationIssue["rule"]>>,
  ): ValidateRows & { calls: string[][] } => {
    const calls: string[][] = [];
    const fn = async (rows: readonly (readonly string[])[]) => {
      const names = rows.map((r) => r[1]!);
      calls.push(names);
      const failing = rounds[calls.length - 1] ?? {};
      const byRule = new Map<ValidationIssue["rule"], number[]>();
      names.forEach((name, i) => {
        const rule = failing[name];
        if (rule) byRule.set(rule, [...(byRule.get(rule) ?? []), i + 1]);
      });
      return report(
        rows.length,
        [...byRule].map(([rule, list]) => issue(rule, list, { column: "name" })),
      );
    };
    return Object.assign(fn, { calls });
  };

  it("is ready at once when the first round finds nothing", async () => {
    const outcome = await planLeaveOut(start(), byName([]), never);
    expect(outcome).toEqual({ kind: "ready", data: start(), rejects: [], rounds: 1 });
  });

  it("leaves out the failing rows and validates the rest again until a round is clean", async () => {
    const validate = byName([{ "b\nb": "not_null" }]);
    const outcome = await planLeaveOut(start(), validate, never);
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.rounds).toBe(2);
    expect(outcome.data.lines).toEqual([2, 6, 7]);
    expect(outcome.rejects).toEqual([
      {
        line: 4,
        row: ["2", "b\nb"],
        reasons: [{ rule: "not_null", column: "name", constraint: null }],
      },
    ]);
    expect(validate.calls).toEqual([
      ["a", "b\nb", "c", "d"],
      ["a", "c", "d"],
    ]);
  });

  it("maps the numbers of a later round back to the file, when leaving rows out reveals new failures", async () => {
    // Round 1: row 1 (a) fails. Round 2, among a shorter request: "d" (now row 3) fails a unique key.
    const validate = byName([{ a: "type" }, { d: "unique_existing" }, {}]);
    const outcome = await planLeaveOut(start(), validate, never);
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.rounds).toBe(3);
    expect(outcome.rejects.map((r) => [r.line, r.row[1], r.reasons[0]!.rule])).toEqual([
      [2, "a", "type"],
      [7, "d", "unique_existing"],
    ]);
    expect(outcome.data.rows).toEqual([
      ["2", "b\nb"],
      ["3", "c"],
    ]);
    expect(outcome.data.lines).toEqual([4, 6]);
  });

  it("keeps every reason a row fails in its round", async () => {
    const validate: ValidateRows = async (rows) =>
      rows.length === 4
        ? report(4, [
            issue("not_null", [2], { column: "qty" }),
            issue("check", [2], { constraint: "positive" }),
          ])
        : report(rows.length);
    const outcome = await planLeaveOut(start(), validate, never);
    expect(outcome.kind === "ready" && outcome.rejects[0]!.reasons).toEqual([
      { rule: "not_null", column: "qty", constraint: null },
      { rule: "check", column: null, constraint: "positive" },
    ]);
  });

  it("leaves nothing out when a report stopped early: too many rows fail", async () => {
    const validate: ValidateRows = async (rows) => report(rows.length, [issue("check", [1])], true);
    expect(await planLeaveOut(start(), validate, never)).toEqual({
      kind: "too_many",
      atLeast: 1,
      rounds: 1,
    });
  });

  it("is too many when the rows left out over the rounds would pass the limit", async () => {
    const big: DataRows = {
      rows: Array.from({ length: LEAVE_OUT_MAX_ROWS + 10 }, (_, i) => [String(i)]),
      lines: Array.from({ length: LEAVE_OUT_MAX_ROWS + 10 }, (_, i) => i + 2),
    };
    let round = 0;
    const validate: ValidateRows = async (rows) => {
      round += 1;
      // 600 fail in round 1, 600 more among the rest in round 2.
      return report(rows.length, [
        issue(
          "check",
          Array.from({ length: 600 }, (_, i) => i + 1),
        ),
      ]);
    };
    const outcome = await planLeaveOut(big, validate, never);
    expect(outcome).toEqual({ kind: "too_many", atLeast: 1200, rounds: 2 });
    expect(round).toBe(2);
  });

  it("stops after the last round that still finds failing rows", async () => {
    const big: DataRows = {
      rows: Array.from({ length: 10 }, (_, i) => [String(i)]),
      lines: Array.from({ length: 10 }, (_, i) => i + 2),
    };
    let calls = 0;
    const validate: ValidateRows = async (rows) => {
      calls += 1;
      return report(rows.length, [issue("foreign_key", [1])]);
    };
    const outcome = await planLeaveOut(big, validate, never);
    expect(calls).toBe(LEAVE_OUT_MAX_ROUNDS);
    expect(outcome.kind).toBe("rounds_exhausted");
    expect(outcome.kind === "rounds_exhausted" && outcome.rejects.map((r) => r.line)).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });

  it("says when every row failed", async () => {
    const validate = byName([
      { a: "check", "b\nb": "check" },
      { c: "check", d: "type" },
    ]);
    const outcome = await planLeaveOut(start(), validate, never);
    expect(outcome.kind).toBe("nothing_left");
    expect(outcome.kind === "nothing_left" && outcome.rejects.map((r) => r.line)).toEqual([
      2, 4, 6, 7,
    ]);
  });

  it("does not guess when a report counts rows it does not name", async () => {
    const validate: ValidateRows = async (rows) =>
      report(rows.length, [issue("unique_existing", [1], { count: 3 })]);
    const outcome = await planLeaveOut(start(), validate, never);
    expect(outcome).toEqual({ kind: "not_listed", rejects: [], rounds: 1 });
  });

  it("stops when cancelled before a round, and after a round's answer", async () => {
    const before = new AbortController();
    before.abort();
    const validate = byName([]);
    await expect(planLeaveOut(start(), validate, before.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(validate.calls).toEqual([]);

    const during = new AbortController();
    let calls = 0;
    const slow: ValidateRows = async (rows, signal) => {
      calls += 1;
      expect(signal).toBe(during.signal);
      during.abort();
      return report(rows.length, [issue("check", [1])]);
    };
    await expect(planLeaveOut(start(), slow, during.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toBe(1);
  });

  it("passes on a validation's own failure", async () => {
    const failing: ValidateRows = async () => {
      throw new Error("deadline");
    };
    await expect(planLeaveOut(start(), failing, never)).rejects.toThrow("deadline");
  });
});
