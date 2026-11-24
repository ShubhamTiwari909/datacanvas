/**
 * A query plan in JSON (`EXPLAIN (FORMAT JSON)`), read into a tree for the plan viewer (`docs/insight-release-plan.md`,
 * section 5; decision 164). Pure functions, no React.
 *
 * The text comes from the database and answers the person's own statement, but it is still read as untrusted: it is
 * bounded (2 MB, 20,000 nodes, nesting of 100), every number is checked to be a finite number and every string is cut
 * for display, and nothing in it is ever used as markup. Nothing here is stored: a plan lives in the tab's memory like a
 * result (a rule test keeps `features/sql/plan*` out of every store).
 */
import { SQL_LIMITS } from "@datacanvas/database-core";

export const PLAN_MAX_NODES = 20_000;
export const PLAN_MAX_DEPTH = 100;
const MAX_TEXT = 300;

/** What deserves the eye in a node, in words (the screen never marks with a colour alone). */
export type PlanMark =
  | { kind: "misestimate"; ratio: number; expected: number; actual: number }
  | { kind: "seq_scan_large"; rows: number }
  | { kind: "spill"; what: "sort" | "hash" }
  | { kind: "most_time"; share: number };

export interface PlanCondition {
  label: string;
  text: string;
}

export interface PlanNode {
  type: string;
  /** "people p", "people", or null. */
  target: string | null;
  index: string | null;
  joinType: string | null;
  strategy: string | null;
  costStart: number | null;
  costTotal: number | null;
  /** Rows the planner expected for one run of the node (`Plan Rows`). */
  expectedRows: number | null;
  /** Rows it produced for one run (`Actual Rows`), with ANALYZE. */
  actualRows: number | null;
  loops: number | null;
  /** Time in the node and what is below it, for all its runs, in milliseconds (with ANALYZE). */
  totalMs: number | null;
  /** Time in the node itself: its total less its children's. */
  selfMs: number | null;
  sharedHit: number | null;
  sharedRead: number | null;
  conditions: PlanCondition[];
  marks: PlanMark[];
  children: PlanNode[];
}

export interface ParsedPlan {
  root: PlanNode;
  nodeCount: number;
  analyzed: boolean;
  planningMs: number | null;
  executionMs: number | null;
}

export type PlanResult = { ok: true; plan: ParsedPlan } | { ok: false; reason: string };

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value.slice(0, MAX_TEXT) : null;

const CONDITIONS: ReadonlyArray<[string, string]> = [
  ["Index Cond", "Index condition"],
  ["Recheck Cond", "Recheck condition"],
  ["Filter", "Filter"],
  ["Join Filter", "Join filter"],
  ["Hash Cond", "Hash condition"],
  ["Merge Cond", "Merge condition"],
  ["TID Cond", "TID condition"],
];

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class TooBig extends Error {}

function readNode(raw: Raw, depth: number, counter: { n: number }, analyzed: boolean): PlanNode {
  if (depth > PLAN_MAX_DEPTH) throw new TooBig("The plan is nested more than 100 levels deep.");
  counter.n += 1;
  if (counter.n > PLAN_MAX_NODES) throw new TooBig("The plan has more than 20,000 steps.");

  const children: PlanNode[] = [];
  const plans = raw["Plans"];
  if (Array.isArray(plans)) {
    for (const child of plans) {
      if (isObject(child)) children.push(readNode(child, depth + 1, counter, analyzed));
    }
  }

  const relation = str(raw["Relation Name"]);
  const alias = str(raw["Alias"]);
  const target = relation
    ? alias && alias !== relation
      ? `${relation} ${alias}`
      : relation
    : null;
  const loops = num(raw["Actual Loops"]);
  const perRunMs = num(raw["Actual Total Time"]);
  const totalMs = perRunMs === null ? null : perRunMs * Math.max(1, loops ?? 1);
  const childrenMs = children.reduce((sum, c) => sum + (c.totalMs ?? 0), 0);
  const expectedRows = num(raw["Plan Rows"]);
  const actualRows = num(raw["Actual Rows"]);
  const type = str(raw["Node Type"]) ?? "Step";

  const conditions: PlanCondition[] = [];
  for (const [key, label] of CONDITIONS) {
    const text = str(raw[key]);
    if (text) conditions.push({ label, text });
  }

  const marks: PlanMark[] = [];
  if (analyzed && expectedRows !== null && actualRows !== null) {
    const high = Math.max(expectedRows, actualRows);
    const low = Math.max(1, Math.min(expectedRows, actualRows));
    // Under 100 rows a wrong guess costs nothing: not worth the eye.
    if (high >= 100 && high / low >= 10) {
      marks.push({
        kind: "misestimate",
        ratio: Math.round(high / low),
        expected: expectedRows,
        actual: actualRows,
      });
    }
  }
  if (type === "Seq Scan" && expectedRows !== null && expectedRows >= 10_000) {
    marks.push({ kind: "seq_scan_large", rows: expectedRows });
  }
  if (
    raw["Sort Space Type"] === "Disk" ||
    (str(raw["Sort Method"]) ?? "").toLowerCase().includes("external")
  ) {
    marks.push({ kind: "spill", what: "sort" });
  }
  const batches = num(raw["Hash Batches"]);
  if ((batches !== null && batches > 1) || (num(raw["Disk Usage"]) ?? 0) > 0) {
    marks.push({ kind: "spill", what: "hash" });
  }

  return {
    type,
    target,
    index: str(raw["Index Name"]),
    joinType: str(raw["Join Type"]),
    strategy: str(raw["Strategy"]),
    costStart: num(raw["Startup Cost"]),
    costTotal: num(raw["Total Cost"]),
    expectedRows,
    actualRows,
    loops,
    totalMs,
    selfMs: totalMs === null ? null : Math.max(0, totalMs - childrenMs),
    sharedHit: num(raw["Shared Hit Blocks"]),
    sharedRead: num(raw["Shared Read Blocks"]),
    conditions,
    marks,
    children,
  };
}

/** Add the "most of the time is here" mark to the node(s) that hold at least half of the plan's time. */
function markMostTime(node: PlanNode, rootMs: number): void {
  if (node.selfMs !== null && rootMs >= 1 && node.selfMs >= 1 && node.selfMs / rootMs >= 0.5) {
    node.marks.push({ kind: "most_time", share: Math.round((node.selfMs / rootMs) * 100) });
  }
  for (const child of node.children) markMostTime(child, rootMs);
}

/** Read the one cell of an `EXPLAIN (FORMAT JSON)` into a tree, or say why it is not one. */
export function parsePlan(text: string): PlanResult {
  if (text.length > SQL_LIMITS.maxPlanChars) {
    return { ok: false, reason: "The plan is larger than 2 MB." };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The plan is not JSON." };
  }
  const first = Array.isArray(json) ? json[0] : json;
  if (!isObject(first) || !isObject(first["Plan"])) {
    return { ok: false, reason: "This is not a plan in JSON." };
  }
  const executionMs = num(first["Execution Time"]);
  const planningMs = num(first["Planning Time"]);
  const analyzed = executionMs !== null;
  const counter = { n: 0 };
  try {
    const root = readNode(first["Plan"], 1, counter, analyzed);
    if (analyzed && root.totalMs !== null) markMostTime(root, root.totalMs);
    return { ok: true, plan: { root, nodeCount: counter.n, analyzed, planningMs, executionMs } };
  } catch (error) {
    if (error instanceof TooBig) return { ok: false, reason: error.message };
    throw error;
  }
}

/** The rows of a result, when they are a plan in JSON (an EXPLAIN that answers one cell). */
export function planFromRows(rows: ReadonlyArray<ReadonlyArray<string | null>>): PlanResult | null {
  if (rows.length !== 1 || rows[0]!.length !== 1 || rows[0]![0] === null) return null;
  const text = rows[0]![0]!;
  // The text format is many rows; the JSON format starts with a bracket.
  if (!/^\s*[[{]/.test(text)) return null;
  return parsePlan(text);
}
