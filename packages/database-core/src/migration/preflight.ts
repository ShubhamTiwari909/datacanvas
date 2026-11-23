/**
 * The pre-flight of a migration (`docs/advanced-data-workspace-plan.md`, section 6.3; decision 157): for the
 * steps the plan marks "can fail on existing rows", ask the database how many rows would make them fail,
 * BEFORE the script is run. "Will step 7 fail?" with a number.
 *
 * A check is a STRUCTURE (a table, columns, the columns a foreign key points at), made here from the plan's
 * steps and the structure the migration goes TO. The adapter then checks every name against the catalog of
 * the database it asks and builds one fixed query per kind; no text of the plan, a snapshot or a constraint
 * ever becomes SQL. That is why a CHECK constraint (its text is an expression) and a narrowing type change
 * are NOT checked here: running them would mean running text that may have come from a file.
 */
import type { DatabaseStructure } from "../structure.js";
import type { MigrationStep } from "./types.js";

/** The most checks in one request. */
export const PREFLIGHT_MAX_CHECKS = 50;

export type PreflightCheck =
  /** `SET NOT NULL`: rows that hold NULL in the column. */
  | { kind: "nulls"; schema: string; table: string; column: string }
  /** A unique key or a primary key: groups of rows that share a value (a key with a NULL never collides). */
  | { kind: "duplicates"; schema: string; table: string; columns: string[] }
  /** A foreign key: rows that point at a row that is not there (a key with a NULL is not checked). */
  | {
      kind: "orphans";
      schema: string;
      table: string;
      columns: string[];
      refSchema: string;
      refTable: string;
      refColumns: string[];
    }
  /** A new column that cannot be NULL and has no default: it fails if the table has any row at all. */
  | { kind: "rows"; schema: string; table: string };

/**
 * What the database answered for one check.
 *  - `ok`: nothing would fail; `fails`: `count` rows (or groups of rows, for `duplicates`) would;
 *  - `missing`: the table or a column is not in this database, so there is nothing to check yet;
 *  - `too_slow`: the check took longer than its time limit;
 *  - `hidden`: a column in the check has a name that looks sensitive, so it is not counted (a count of
 *    shared values or of rows that match another table would tell what the column holds).
 */
export interface PreflightResult {
  status: "ok" | "fails" | "missing" | "too_slow" | "hidden";
  count: number;
}

/** Why a step that can fail has no check. Fixed sentences. */
export const NOT_CHECKABLE: Record<"check" | "type" | "other", string> = {
  check:
    "A check constraint is an expression, and it is not run against your data here. Try it in the SQL tab first.",
  type: "Whether every value fits the new type is not checked here. Try the conversion in the SQL tab first.",
  other: "This step can fail, and it is not one this check can try.",
};

export interface PlannedChecks {
  stepId: string;
  /** The checks that answer "will this step fail?"; empty when none can be made. */
  checks: PreflightCheck[];
  /** When there are none: why. */
  unchecked: keyof typeof NOT_CHECKABLE | null;
}

/**
 * The checks for each step that can fail on rows that exist. `to` is the structure the migration goes to:
 * that is where the definition of a constraint the step adds is found.
 */
export function planPreflight(
  steps: readonly MigrationStep[],
  to: DatabaseStructure,
): PlannedChecks[] {
  const out: PlannedChecks[] = [];
  for (const step of steps) {
    if (!step.risk.includes("may_fail")) continue;
    const { schema, table, column, name } = step.object;
    const none = (unchecked: PlannedChecks["unchecked"]): PlannedChecks => ({
      stepId: step.id,
      checks: [],
      unchecked,
    });
    const some = (checks: PreflightCheck[]): PlannedChecks => ({
      stepId: step.id,
      checks,
      unchecked: null,
    });
    if (step.object.of !== undefined) {
      out.push(none("other"));
      continue;
    }
    if (step.kind === "set_not_null" && column) {
      out.push(some([{ kind: "nulls", schema, table, column }]));
    } else if (step.kind === "add_column" && column) {
      out.push(some([{ kind: "rows", schema, table }]));
    } else if (step.kind === "alter_column_type") {
      out.push(none("type"));
    } else if ((step.kind === "add_constraint" || step.kind === "validate_constraint") && name) {
      const found = to.tables
        .find((t) => t.schema === schema && t.name === table)
        ?.constraints.find((c) => c.name === name);
      if (!found) {
        out.push(none("other"));
      } else if (found.kind === "primary_key") {
        out.push(
          some([
            ...found.columns.map((c): PreflightCheck => ({
              kind: "nulls",
              schema,
              table,
              column: c,
            })),
            { kind: "duplicates", schema, table, columns: found.columns },
          ]),
        );
      } else if (
        found.kind === "unique" &&
        /\bNULLS\s+NOT\s+DISTINCT\b/i.test(found.definition ?? "")
      ) {
        // NULLs count as equal here: the check below skips NULL rows, so it would call a failing step fine.
        out.push(none("other"));
      } else if (found.kind === "foreign_key" && /\bMATCH\s+FULL\b/i.test(found.definition ?? "")) {
        // MATCH FULL fails on a key that is only partly NULL, which the check below leaves out.
        out.push(none("other"));
      } else if (found.kind === "unique") {
        out.push(some([{ kind: "duplicates", schema, table, columns: found.columns }]));
      } else if (found.kind === "foreign_key") {
        const link = to.relationships.find(
          (r) => r.name === name && r.source.schema === schema && r.source.table === table,
        );
        out.push(
          link
            ? some([
                {
                  kind: "orphans",
                  schema,
                  table,
                  columns: link.source.columns,
                  refSchema: link.target.schema,
                  refTable: link.target.table,
                  refColumns: link.target.columns,
                },
              ])
            : none("other"),
        );
      } else if (found.kind === "check") {
        out.push(none("check"));
      } else {
        out.push(none("other"));
      }
    } else {
      out.push(none("other"));
    }
  }
  return out;
}

/** One sentence for what a check found, from fixed words and a number. Never a value. */
export function describePreflight(check: PreflightCheck, result: PreflightResult): string {
  if (result.status === "missing") {
    return "Not in this database yet, so there is nothing to check.";
  }
  if (result.status === "too_slow") return "The check took too long and was stopped.";
  if (result.status === "hidden") {
    return "A column here has a name that looks sensitive, so it is not counted: a count would tell what it holds.";
  }
  const n = result.count;
  const rows = (k: number) => `${k.toLocaleString("en-US")} ${k === 1 ? "row" : "rows"}`;
  switch (check.kind) {
    case "nulls":
      return result.status === "ok"
        ? `No row has NULL in ${check.column}.`
        : `${rows(n)} ${n === 1 ? "has" : "have"} NULL in ${check.column}, so this step would fail.`;
    case "duplicates":
      return result.status === "ok"
        ? `No two rows share a value of (${check.columns.join(", ")}).`
        : `${n.toLocaleString("en-US")} ${n === 1 ? "value is" : "values are"} shared by more than one row of (${check.columns.join(", ")}), so this step would fail.`;
    case "orphans":
      return result.status === "ok"
        ? `Every row points at a row that exists in ${check.refTable}.`
        : `${rows(n)} point${n === 1 ? "s" : ""} at a row that does not exist in ${check.refTable}, so this step would fail.`;
    case "rows":
      return result.status === "ok"
        ? "The table is empty, so a column that cannot be NULL can be added."
        : "The table has rows, so a column that cannot be NULL and has no default cannot be added.";
  }
}

/** The one verdict of a step with several checks: the worst of them. */
export function preflightVerdict(
  results: readonly PreflightResult[],
): "ok" | "fails" | "partly" | "unchecked" {
  if (results.length === 0) return "unchecked";
  if (results.some((r) => r.status === "fails")) return "fails";
  if (results.every((r) => r.status === "ok")) return "ok";
  return "partly";
}
