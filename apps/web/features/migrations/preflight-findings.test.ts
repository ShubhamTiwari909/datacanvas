import type { PlannedChecks, PreflightCheck, PreflightResult } from "@datacanvas/database-core";
import { PREFLIGHT_MAX_CHECKS } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { findingsFor, flattenChecks, inRequests } from "./preflight-findings";

const nulls = (column: string): PreflightCheck => ({
  kind: "nulls",
  schema: "public",
  table: "t",
  column,
});
const planned: PlannedChecks[] = [
  { stepId: "s1", checks: [nulls("a")], unchecked: null },
  { stepId: "s2", checks: [], unchecked: "check" },
  { stepId: "s3", checks: [nulls("b"), nulls("c")], unchecked: null },
];

describe("findingsFor", () => {
  it("puts each answer back with its step, in order, and the worst of a step's answers is its verdict", () => {
    expect(flattenChecks(planned).map((c) => (c as { column: string }).column)).toEqual([
      "a",
      "b",
      "c",
    ]);
    const results: PreflightResult[] = [
      { status: "fails", count: 3 },
      { status: "ok", count: 0 },
      { status: "fails", count: 1 },
    ];
    const found = findingsFor(planned, results);
    expect(found.get("s1")).toEqual({
      verdict: "fails",
      lines: ["3 rows have NULL in a, so this step would fail."],
    });
    expect(found.get("s3")!.verdict).toBe("fails");
    expect(found.get("s3")!.lines).toEqual([
      "No row has NULL in b.",
      "1 row has NULL in c, so this step would fail.",
    ]);
  });

  it("says why a step was not tried, without running anything for it", () => {
    const found = findingsFor(planned, [
      { status: "ok", count: 0 },
      { status: "ok", count: 0 },
      { status: "ok", count: 0 },
    ]);
    expect(found.get("s2")!.verdict).toBe("unchecked");
    expect(found.get("s2")!.lines[0]).toMatch(/check constraint is an expression/);
  });

  it("treats a missing answer as nothing to check, not as a pass", () => {
    const found = findingsFor(planned, []);
    expect(found.get("s1")!.verdict).toBe("partly");
  });
});

describe("a plan that renames", () => {
  it("does not say 'not in this database yet' for a name the migration changes", () => {
    const missing = [{ status: "missing", count: 0 }] as const;
    const one: PlannedChecks[] = [{ stepId: "s1", checks: [nulls("a")], unchecked: null }];
    expect(findingsFor(one, missing).get("s1")!.lines[0]).toMatch(/nothing to check/);
    const renamed = findingsFor(one, missing, true).get("s1")!;
    expect(renamed.lines[0]).toMatch(/renames something/);
    expect(renamed.lines[0]).not.toMatch(/nothing to check/);
    expect(renamed.verdict).toBe("partly");
  });
});

describe("inRequests", () => {
  it("splits the checks into requests of at most the limit", () => {
    const many = Array.from({ length: PREFLIGHT_MAX_CHECKS * 2 + 3 }, (_, i) => nulls(`c${i}`));
    expect(inRequests(many).map((r) => r.length)).toEqual([
      PREFLIGHT_MAX_CHECKS,
      PREFLIGHT_MAX_CHECKS,
      3,
    ]);
    expect(inRequests([])).toEqual([]);
  });
});
