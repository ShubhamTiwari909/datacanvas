/**
 * Filtering, as the person sees it: the words for each condition, which columns and
 * operators the panel offers, whether a condition can be added, and how a filter
 * reads in a chip and in the note under the grid. Pure: no React, no rows.
 */
import {
  FILTER_SHAPE,
  ROWS_MAX_FILTER_GROUPS,
  ROWS_MAX_FILTER_PATH,
  ROWS_MAX_FILTER_PATH_CHARS,
  ROWS_MAX_FILTER_VALUE_CHARS,
  ROWS_MAX_FILTER_VALUES,
  ROWS_MAX_FILTERS,
  ROW_FILTER_OPS,
  filterOpsFor,
  type RowColumn,
  type RowFilter,
  type RowFilterOp,
  type RowFilterShape,
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
  ends_with: "ends with",
  not_contains: "does not contain",
  matches: "matches the pattern",
  is_empty: "is empty",
  in: "is one of",
  not_in: "is none of",
  between: "is between",
  today: "is today",
  last_7_days: "is in the last 7 days",
  last_30_days: "is in the last 30 days",
  this_month: "is in this month",
  has_key: "has the key",
  json_contains: "contains the JSON",
  json_path_eq: "at a path equals",
  array_contains: "contains all of",
  array_overlaps: "contains any of",
  array_is_empty: "is an empty list",
  is_null: "is NULL",
  is_not_null: "is not NULL",
};

export const shapeOf = (op: RowFilterOp): RowFilterShape => FILTER_SHAPE[op];

/** Does the condition take a single typed value? (The two tests for NULL and the shortcuts take none.) */
export const needsValue = (op: RowFilterOp): boolean => {
  const shape = shapeOf(op);
  return shape === "one" || shape === "path";
};

/** The columns a condition can be put on: every column that was read and is not hidden. */
export const filterableColumns = (columns: readonly RowColumn[]): RowColumn[] =>
  columns.filter((column) => !column.masked);

/** The operators the panel offers for a column, in a fixed, readable order. */
export function operatorsFor(column: RowColumn | undefined): RowFilterOp[] {
  if (!column) return [];
  const allowed = filterOpsFor(column.kind, column.dataType);
  return ROW_FILTER_OPS.filter((op) => allowed.includes(op));
}

/** "equals" for a column that has it, else the first test the column allows. */
export function defaultOperator(column: RowColumn | undefined): RowFilterOp {
  return operatorsFor(column)[0] ?? "eq";
}

/** A short hint for the value box, by what the column holds and what the condition asks. */
export function valueHint(column: RowColumn | undefined, op: RowFilterOp): string {
  if (!column) return "";
  switch (op) {
    case "contains":
    case "starts_with":
    case "ends_with":
    case "not_contains":
      return "Text to look for (any case)";
    case "matches":
      return "A pattern, such as ^ann or \\d{3}$ (any case)";
    case "has_key":
      return "A key at the top level";
    case "json_contains":
      return 'JSON, such as {"status": "open"}';
    case "json_path_eq":
      return "The value at the path, as text";
    default:
      return column.kind === "text"
        ? "Text, exactly as stored"
        : `A value of type ${column.dataType}`;
  }
}

/** The names of the groups: "A", "B", "C". */
export const groupLetter = (group: number): string => String.fromCharCode(64 + group);
export const GROUPS = Array.from({ length: ROWS_MAX_FILTER_GROUPS }, (_, i) => i + 1);

/** What the panel holds while a condition is being made. A group of 0 is "none". */
export interface FilterDraft {
  column: RowColumn | undefined;
  op: RowFilterOp;
  value: string;
  /** One value per line, for the operators that take a list. */
  list: string;
  /** The two ends of "between". */
  low: string;
  high: string;
  /** Steps of a path into JSON, separated by dots: `a.b.0`. */
  path: string;
  group: number;
}

export const emptyDraft = (column: RowColumn | undefined, op: RowFilterOp): FilterDraft => ({
  column,
  op,
  value: "",
  list: "",
  low: "",
  high: "",
  path: "",
  group: 0,
});

/** The lines of a list box: blank lines are dropped, because an empty value is asked for with "is empty". */
export const listValues = (text: string): string[] =>
  text.split(/\r\n|\r|\n/).filter((line) => line !== "");

export const pathSteps = (text: string): string[] => text.split(".").filter((step) => step !== "");

const tooLong = (v: string) => v.length > ROWS_MAX_FILTER_VALUE_CHARS;

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
  const shape = shapeOf(draft.op);
  const text = draft.column.kind === "text";
  if (shape === "none") return { ok: true };
  if (shape === "one" || shape === "path") {
    if (tooLong(draft.value)) {
      return {
        ok: false,
        reason: `A value can be at most ${ROWS_MAX_FILTER_VALUE_CHARS} characters.`,
      };
    }
    // The empty string is a value for text (rows whose text is empty); for other types it is never valid.
    if (draft.value === "" && (!text || shape === "path" || draft.op === "has_key")) {
      return { ok: false, reason: "Type a value." };
    }
    if (shape === "path") {
      const steps = pathSteps(draft.path);
      if (steps.length === 0) return { ok: false, reason: "Type the path, such as address.city." };
      if (steps.length > ROWS_MAX_FILTER_PATH) {
        return { ok: false, reason: `A path can have at most ${ROWS_MAX_FILTER_PATH} steps.` };
      }
      if (steps.some((s) => s.length > ROWS_MAX_FILTER_PATH_CHARS)) {
        return {
          ok: false,
          reason: `A step can be at most ${ROWS_MAX_FILTER_PATH_CHARS} characters.`,
        };
      }
    }
    return { ok: true };
  }
  if (shape === "list") {
    const values = listValues(draft.list);
    if (values.length === 0) return { ok: false, reason: "Type at least one value, one per line." };
    if (values.length > ROWS_MAX_FILTER_VALUES) {
      return { ok: false, reason: `At most ${ROWS_MAX_FILTER_VALUES} values.` };
    }
    if (values.some(tooLong)) {
      return {
        ok: false,
        reason: `A value can be at most ${ROWS_MAX_FILTER_VALUE_CHARS} characters.`,
      };
    }
    return { ok: true };
  }
  // between
  if (draft.low === "" || draft.high === "") return { ok: false, reason: "Type both ends." };
  if (tooLong(draft.low) || tooLong(draft.high)) {
    return {
      ok: false,
      reason: `A value can be at most ${ROWS_MAX_FILTER_VALUE_CHARS} characters.`,
    };
  }
  return { ok: true };
}

/** The condition as the request carries it: only the fields its operator takes. */
export function makeFilter(column: RowColumn, draft: FilterDraft): RowFilter {
  const filter: RowFilter = { column: column.name, op: draft.op };
  const shape = shapeOf(draft.op);
  if (shape === "one") filter.value = draft.value;
  if (shape === "list") filter.values = listValues(draft.list);
  if (shape === "two") filter.values = [draft.low, draft.high];
  if (shape === "path") {
    filter.path = pathSteps(draft.path);
    filter.value = draft.value;
  }
  if (draft.group > 0) filter.group = draft.group;
  return filter;
}

const CHIP_VALUE_CHARS = 40;
const cut = (v: string): string =>
  v.length > CHIP_VALUE_CHARS ? `${v.slice(0, CHIP_VALUE_CHARS)}…` : v;

/** `email contains "ann"`: for a chip and for the note. A long value is cut for display only. */
export function describeFilter(filter: RowFilter): string {
  const label = FILTER_OP_LABELS[filter.op];
  const shape = shapeOf(filter.op);
  let text = `${filter.column} ${label}`;
  if (shape === "one") text += ` "${cut(filter.value ?? "")}"`;
  else if (shape === "list")
    text += ` ${(filter.values ?? []).map((v) => `"${cut(v)}"`).join(", ")}`;
  else if (shape === "two")
    text += ` "${cut(filter.values?.[0] ?? "")}" and "${cut(filter.values?.[1] ?? "")}"`;
  else if (shape === "path") {
    text = `${filter.column} at ${(filter.path ?? []).join(".")} equals "${cut(filter.value ?? "")}"`;
  }
  return filter.group !== undefined ? `${text} (any of ${groupLetter(filter.group)})` : text;
}

/** Every condition, in the order given, for the note under the grid. */
export const describeFilters = (filters: readonly RowFilter[]): string =>
  filters.map(describeFilter).join("; ");

/**
 * "Filter by this value": a condition for a cell, or null when the column cannot be asked for one
 * (a column that is not text or ordered, or a value that was cut and so is not the whole value).
 */
export function filterForCell(
  column: RowColumn,
  value: string | null,
  truncated: boolean,
): RowFilter | null {
  if (column.masked) return null;
  if (value === null) {
    return filterOpsFor(column.kind, column.dataType).includes("is_null")
      ? { column: column.name, op: "is_null" }
      : null;
  }
  if (truncated || value.length > ROWS_MAX_FILTER_VALUE_CHARS) return null;
  if (column.kind !== "text" && column.kind !== "ordered") return null;
  return { column: column.name, op: "eq", value };
}
