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
  type Change,
  type PlannedChange,
} from "@datacanvas/database-core";
import type { WriteClient } from "../connection/write.js";
import type { Queryable } from "../introspection/types.js";
import { verifyGuard } from "./guard.js";
import { planRowChange } from "./rows.js";
import { planStructureChange } from "./structure.js";

export { describeForEdit } from "./rows.js";

export function planChange(db: Queryable, change: Change): Promise<PlannedChange> {
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
export async function runPlan(db: WriteClient, plan: PlannedChange): Promise<AppliedChange> {
  // Lock what the plan is about and check it is still the same table, before anything runs.
  await verifyGuard(db, plan);
  let rowCount = 0;
  for (const statement of plan.statements) {
    const result = await db.query(statement.text, statement.values);
    const count = result.rowCount ?? 0;
    if (plan.expect === "one_row") {
      if (count === 0) throw new DatabaseError("row_changed");
      if (count !== 1) throw new DatabaseError("unexpected");
    }
    rowCount += count;
  }
  return { rowCount };
}
