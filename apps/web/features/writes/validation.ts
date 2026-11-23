/**
 * Validation from a form (`docs/advanced-data-workspace-plan.md`, section 6.2): the request that asks "would
 * the database accept this?" is made from the very change the form would preview, so what is checked is
 * what would be written. Pure functions, no React.
 */
import type { InsertRowChange, UpdateRowChange } from "@datacanvas/database-core";
import type { ValidateRequestBody } from "@datacanvas/shared-types";

/** The validation of an insert (a row of the values given) or of an update (one row, found by its key). */
export function validateRequestFor(change: InsertRowChange | UpdateRowChange): ValidateRequestBody {
  if (change.kind === "insert_row") {
    return {
      schema: change.table.schema,
      table: change.table.name,
      mode: "insert",
      columns: change.values.map((v) => v.column),
      rows: [change.values.map((v) => v.value)],
    };
  }
  return {
    schema: change.table.schema,
    table: change.table.name,
    mode: "update",
    columns: change.set.map((s) => s.column),
    rows: [change.set.map((s) => s.value)],
    key: change.key.map((k) => ({ column: k.column, value: k.value })),
  };
}
