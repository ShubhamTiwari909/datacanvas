import { SQL_LIMITS } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { PLAN_MAX_DEPTH, PLAN_MAX_NODES, parsePlan, planFromRows } from "./plan";

const wrap = (plan: object, extra: object = {}) => JSON.stringify([{ Plan: plan, ...extra }]);

const sample = wrap(
  {
    "Node Type": "Sort",
    "Total Cost": 900.5,
    "Startup Cost": 880.1,
    "Plan Rows": 5000,
    "Actual Rows": 4800,
    "Actual Loops": 1,
    "Actual Total Time": 100,
    "Sort Method": "external merge",
    "Sort Space Type": "Disk",
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Relation Name": "people",
        Alias: "p",
        "Plan Rows": 50000,
        "Actual Rows": 400,
        "Actual Loops": 1,
        "Actual Total Time": 80,
        Filter: "(status = 'vip'::text)",
        "Shared Hit Blocks": 12,
        "Shared Read Blocks": 300,
      },
    ],
  },
  { "Planning Time": 0.4, "Execution Time": 101.2 },
);

describe("parsePlan", () => {
  it("reads the tree, the numbers, the target and the conditions", () => {
    const result = parsePlan(sample);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { plan } = result;
    expect(plan.nodeCount).toBe(2);
    expect(plan.analyzed).toBe(true);
    expect(plan.executionMs).toBe(101.2);
    expect(plan.root.type).toBe("Sort");
    const scan = plan.root.children[0]!;
    expect(scan.target).toBe("people p");
    expect(scan.conditions).toEqual([{ label: "Filter", text: "(status = 'vip'::text)" }]);
    expect(scan.sharedRead).toBe(300);
    // Time in the node itself is its total less its children's.
    expect(plan.root.selfMs).toBeCloseTo(20);
    expect(scan.selfMs).toBeCloseTo(80);
  });

  it("marks what deserves the eye, each in a kind of its own", () => {
    const result = parsePlan(sample);
    if (!result.ok) throw new Error("not a plan");
    const [sort, scan] = [result.plan.root, result.plan.root.children[0]!];
    expect(sort.marks).toEqual([{ kind: "spill", what: "sort" }]);
    expect(scan.marks).toEqual([
      { kind: "misestimate", ratio: 125, expected: 50000, actual: 400 },
      { kind: "seq_scan_large", rows: 50000 },
      { kind: "most_time", share: 80 },
    ]);
  });

  it("does not mark small guesses, a plan without ANALYZE for a misestimate, or a small scan", () => {
    const small = parsePlan(
      wrap(
        {
          "Node Type": "Seq Scan",
          "Relation Name": "t",
          "Plan Rows": 9,
          "Actual Rows": 1,
          "Actual Loops": 1,
        },
        { "Execution Time": 1 },
      ),
    );
    expect(small.ok && small.plan.root.marks).toEqual([]);
    const plain = parsePlan(
      wrap({ "Node Type": "Seq Scan", "Relation Name": "t", "Plan Rows": 100000 }),
    );
    expect(plain.ok && plain.plan.analyzed).toBe(false);
    expect(plain.ok && plain.plan.root.marks).toEqual([{ kind: "seq_scan_large", rows: 100000 }]);
  });

  it("marks a hash that spilled to batches", () => {
    const result = parsePlan(wrap({ "Node Type": "Hash", "Hash Batches": 8 }));
    expect(result.ok && result.plan.root.marks).toEqual([{ kind: "spill", what: "hash" }]);
  });

  it("multiplies the time of a node by its loops", () => {
    const result = parsePlan(
      wrap(
        { "Node Type": "Index Scan", "Actual Total Time": 0.5, "Actual Loops": 200 },
        { "Execution Time": 100 },
      ),
    );
    expect(result.ok && result.plan.root.totalMs).toBeCloseTo(100);
  });
});

describe("parsePlan refuses what is not a plan, and bounds what is", () => {
  it("is not JSON, not an object, or has no plan", () => {
    expect(parsePlan("Seq Scan on t")).toEqual({ ok: false, reason: "The plan is not JSON." });
    expect(parsePlan("[1,2]").ok).toBe(false);
    expect(parsePlan('[{"Plan": "x"}]').ok).toBe(false);
    expect(parsePlan("{}").ok).toBe(false);
  });

  it("refuses a plan nested deeper than the limit", () => {
    let node: object = { "Node Type": "Result" };
    for (let i = 0; i < PLAN_MAX_DEPTH; i++) node = { "Node Type": "Nested", Plans: [node] };
    const result = parsePlan(wrap(node));
    expect(result).toEqual({ ok: false, reason: "The plan is nested more than 100 levels deep." });
    // One level less is fine.
    let ok: object = { "Node Type": "Result" };
    for (let i = 0; i < PLAN_MAX_DEPTH - 2; i++) ok = { "Node Type": "Nested", Plans: [ok] };
    expect(parsePlan(wrap(ok)).ok).toBe(true);
  });

  it("refuses a plan with more steps than the limit", () => {
    const plans = Array.from({ length: PLAN_MAX_NODES }, () => ({ "Node Type": "Result" }));
    const result = parsePlan(wrap({ "Node Type": "Append", Plans: plans }));
    expect(result).toEqual({ ok: false, reason: "The plan has more than 20,000 steps." });
  });

  it("refuses text larger than a plan can be", () => {
    expect(parsePlan(" ".repeat(SQL_LIMITS.maxPlanChars + 1)).ok).toBe(false);
  });

  it("reads numbers only when they are numbers, and cuts a long string", () => {
    const result = parsePlan(
      wrap({
        "Node Type": "x".repeat(5000),
        "Plan Rows": "many",
        "Total Cost": null,
        "Actual Loops": { evil: true },
        Filter: "y".repeat(5000),
        __proto__: { polluted: true },
        Plans: ["not a node", 7, null, { "Node Type": "Child" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.root.type).toHaveLength(300);
    expect(result.plan.root.expectedRows).toBeNull();
    expect(result.plan.root.costTotal).toBeNull();
    expect(result.plan.root.loops).toBeNull();
    expect(result.plan.root.conditions[0]!.text).toHaveLength(300);
    expect(result.plan.root.children).toHaveLength(1);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("derived numbers are numbers", () => {
  it("a time that overflows is no time, never Infinity or NaN on the screen", () => {
    const result = parsePlan(
      wrap(
        {
          "Node Type": "Result",
          "Actual Loops": 1e308,
          "Actual Total Time": 1e308,
          Plans: [{ "Node Type": "Child", "Actual Loops": 1e308, "Actual Total Time": 1e308 }],
        },
        { "Execution Time": 1 },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const node of [result.plan.root, result.plan.root.children[0]!]) {
      expect(node.totalMs).toBeNull();
      expect(node.selfMs).toBeNull();
    }
  });
});

describe("planFromRows", () => {
  it("is a plan only for one cell that starts like JSON; a text plan is many rows", () => {
    expect(planFromRows([[sample]])?.ok).toBe(true);
    expect(planFromRows([["Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)"]])).toBeNull();
    expect(planFromRows([["a"], ["b"]])).toBeNull();
    expect(planFromRows([[null]])).toBeNull();
    expect(planFromRows([])).toBeNull();
    expect(planFromRows([["a", "b"]])).toBeNull();
  });
});
