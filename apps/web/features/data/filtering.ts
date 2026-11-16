/**
 * Filtering, as the person sees it: the words for each condition, which columns and
 * operators the panel offers, whether a condition can be added, and how a filter
 * reads in a chip and in the note under the grid. Pure: no React, no rows.
 */
import {
  ROWS_MAX_FILTER_VALUE_CHARS,
  ROWS_MAX_FILTERS,
  ROW_FILTER_OPS,
  filterOpsFor,
  type RowColumn,
  type RowFilter,
  type RowFilterOp,
} from "@datacanvas/database-core";

export const FILTER_OP_LABELS: Record<RowFilterOp, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  contains: "contains",
  starts_with: "starts with",
  is_null: "is NULL",
  is_not_null: "is not NULL",
};

/** The two tests for NULL take no value; every other condition does. */
export const needsValue = (op: RowFilterOp): boolean => op !== "is_null" && op !== "is_not_null";

/** The columns a condition can be put on: every column that was read and is not hidden. */
export const filterableColumns = (columns: readonly RowColumn[]): RowColumn[] =>
  columns.filter((column) => !column.masked);

/** The operators the panel offers for a column, in a fixed, readable order. */
export function operatorsFor(column: RowColumn | undefined): RowFilterOp[] {
  if (!column) return [];
  const allowed = filterOpsFor(column.kind);
  return ROW_FILTER_OPS.filter((op) => allowed.includes(op));
}

/** "equals" for a column that has it, else the first test the column allows. */
export function defaultOperator(column: RowColumn | undefined): RowFilterOp {
  return operatorsFor(column)[0] ?? "eq";
}

/** A short hint for the value box, by what the column holds. */
export function valueHint(column: RowColumn | undefined, op: RowFilterOp): string {
  if (!column) return "";
  if (op === "contains" || op === "starts_with") return "Text to look for (any case)";
  if (column.kind === "text") return "Text, exactly as stored";
  return `A value of type ${column.dataType}`;
}

export interface FilterDraft {
  column: RowColumn | undefined;
  op: RowFilterOp;
  value: string;
}

/** Can this condition be added now? When not, the reason in one sentence. */
export function canAddFilter(
  filters: readonly RowFilter[],
  draft: FilterDraft,
): { ok: true } | { ok: false; reason: string } {
  if (filters.length >= ROWS_MAX_FILTERS) {
    return {
      ok: false,
      reason: `At most ${ROWS_MAX_FILTERS} filters at a time. Remove one to add another.`,
    };
  }
  if (!draft.column) return { ok: false, reason: "Choose a column." };
  if (!operatorsFor(draft.column).includes(draft.op)) {
    return { ok: false, reason: "This condition is not available for this column." };
  }
  if (!needsValue(draft.op)) return { ok: true };
  if (draft.value.length > ROWS_MAX_FILTER_VALUE_CHARS) {
    return {
      ok: false,
      reason: `A value can be at most ${ROWS_MAX_FILTER_VALUE_CHARS} characters.`,
    };
  }
  // The empty string is a value for text (rows whose text is empty); for other types it is never valid.
  if (draft.value === "" && draft.column.kind !== "text") {
    return { ok: false, reason: "Type a value." };
  }
  return { ok: true };
}

/** The condition as the request carries it. A condition that needs no value has none. */
export function makeFilter(column: RowColumn, op: RowFilterOp, value: string): RowFilter {
  return needsValue(op) ? { column: column.name, op, value } : { column: column.name, op };
}

const CHIP_VALUE_CHARS = 40;

/** `email contains "ann"`: for a chip and for the note. A long value is cut for display only. */
export function describeFilter(filter: RowFilter): string {
  const label = FILTER_OP_LABELS[filter.op];
  if (filter.value === undefined) return `${filter.column} ${label}`;
  const shown =
    filter.value.length > CHIP_VALUE_CHARS
      ? `${filter.value.slice(0, CHIP_VALUE_CHARS)}…`
      : filter.value;
  return `${filter.column} ${label} "${shown}"`;
}

/** Every condition, in the order given, for the note under the grid. */
export const describeFilters = (filters: readonly RowFilter[]): string =>
  filters.map(describeFilter).join("; ");
