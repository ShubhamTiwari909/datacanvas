/**
 * The write path of the PostgreSQL adapter: plan a change (read-only), then
 * run exactly the planned statements (read-write). See
 * `docs/data-editing-plan.md` and `WritableAdapter` in database-core.
 */
import {
  DatabaseError,
  STRUCTURE_CHANGE_KINDS,
  isRowChange,
  type AppliedChange,
  type CancelSignal,
  type Change,
  type PlannedChange,
} from "@datacanvas/database-core";
import type { WriteClient } from "../connection/write.js";
import type { Queryable } from "../introspection/types.js";
import { verifyGuard } from "./guard.js";
import { planUpdateByKey, planUpsertRows } from "./keyed.js";
import { planRowChange } from "./rows.js";
import { planStructureChange } from "./structure.js";

export { describeForEdit } from "./rows.js";

export function planChange(db: Queryable, change: Change): Promise<PlannedChange> {
  // The imports by key have their own planners (`keyed.ts`), with their own statement shapes.
  if (change.kind === "upsert_rows") return planUpsertRows(db, change);
  if (change.kind === "update_by_key") return planUpdateByKey(db, change);
  if (isRowChange(change)) return planRowChange(db, change);
  // Only the kinds on the list: an unknown kind never reaches a builder.
  if (!(STRUCTURE_CHANGE_KINDS as readonly string[]).includes(change.kind)) {
    return Promise.reject(
      new DatabaseError("invalid_change", { message: "This kind of change is not offered." }),
    );
  }
  return planStructureChange(db, change);
}

/**
 * Run the planned statements in order, inside the caller's write transaction.
 * For a row change every statement must report exactly one row: none means the
 * row changed or went away since it was seen (`row_changed`), more than one
 * cannot happen with a key and is treated as a failure. Throwing here makes
 * the transaction roll back, so nothing is written in either case.
 */
export async function runPlan(
  db: WriteClient,
  plan: PlannedChange,
  signal?: CancelSignal,
): Promise<AppliedChange> {
  // Lock what the plan is about and check it is still the same table, before anything runs.
  await verifyGuard(db, plan);
  let rowCount = 0;
  // An upsert batch that says row by row whether it inserted (`countsInserted`): the rows it inserted, counted here.
  let inserted = 0;
  let counted = false;
  for (const statement of plan.statements) {
    // A cancel (the person closed the import) stops between statements: the transaction rolls back.
    if (signal?.aborted)
      throw new DatabaseError("unexpected", { message: "The change was cancelled." });
    const result = await db.query(statement.text, statement.values);
    const count = result.rowCount ?? 0;
    // A statement that was planned for a number of rows must report exactly that many, or nothing is kept.
    if (statement.expectRows !== undefined && count !== statement.expectRows) {
      // "A row changed" is about a row the statement had to find: an insert (an import batch) finds none. An update
      // by key that finds fewer rows than it carries found a row gone (or its key changed) since the preview.
      const inserting = /^\s*INSERT\b/i.test(statement.text);
      throw new DatabaseError(
        count < statement.expectRows && !inserting ? "row_changed" : "unexpected",
      );
    }
    if (statement.countsInserted) {
      counted = true;
      inserted += result.rows.filter((r) => (r as { inserted?: unknown }).inserted === true).length;
    }
    if (plan.expect === "one_row") {
      if (count === 0) throw new DatabaseError("row_changed");
      if (count !== 1) throw new DatabaseError("unexpected");
    }
    rowCount += count;
  }
  // A cancel that came during the last statement is still honoured: the caller commits only when this returns.
  if (signal?.aborted)
    throw new DatabaseError("unexpected", { message: "The change was cancelled." });
  const split = importSplit(plan, rowCount, counted ? inserted : null);
  if (split) return { rowCount, split };
  return { rowCount };
}

/**
 * How the rows of an import by key split: counted by the database where it could say so, else the preview's
 * estimate (whose sum the batches checked). Never a value: counts only.
 */
function importSplit(
  plan: PlannedChange,
  rowCount: number,
  inserted: number | null,
): AppliedChange["split"] {
  const change = plan.change;
  if (change.kind === "update_by_key") return { inserted: 0, updated: rowCount, exact: true };
  if (change.kind !== "upsert_rows") return undefined;
  if (change.updateColumns.length === 0) return { inserted: rowCount, updated: 0, exact: true };
  if (inserted !== null) return { inserted, updated: rowCount - inserted, exact: true };
  return {
    inserted: plan.counts?.insert ?? 0,
    updated: plan.counts?.update ?? 0,
    exact: false,
  };
}
