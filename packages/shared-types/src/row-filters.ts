/**
 * The conditions a person can put on the rows of a table, as the API carries them
 * (`docs/advanced-data-workspace-plan.md`, section 4). The operator list and the limits are the
 * core's (`database-core/src/models.ts`, `rows.ts`); a type test and a contract test keep them in step.
 */
import { z } from "zod";

export const ROW_FILTER_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "ends_with",
  "not_contains",
  "matches",
  "is_empty",
  "in",
  "not_in",
  "between",
  "today",
  "last_7_days",
  "last_30_days",
  "this_month",
  "has_key",
  "json_contains",
  "json_path_eq",
  "array_contains",
  "array_overlaps",
  "array_is_empty",
  "is_null",
  "is_not_null",
] as const;

export const MAX_ROW_FILTERS = 10;
export const MAX_ROW_FILTER_VALUE_CHARS = 200;
export const MAX_ROW_FILTER_VALUES = 50;
export const MAX_ROW_FILTER_PATH = 10;
export const MAX_ROW_FILTER_PATH_CHARS = 100;
export const MAX_ROW_FILTER_GROUPS = 3;

/** What an operator takes (none, one value, a list, two ends, or a path and a value). */
export const ROW_FILTER_SHAPE: Record<
  (typeof ROW_FILTER_OPERATORS)[number],
  "none" | "one" | "list" | "two" | "path"
> = {
  eq: "one",
  neq: "one",
  gt: "one",
  gte: "one",
  lt: "one",
  lte: "one",
  contains: "one",
  starts_with: "one",
  ends_with: "one",
  not_contains: "one",
  matches: "one",
  is_empty: "none",
  in: "list",
  not_in: "list",
  between: "two",
  today: "none",
  last_7_days: "none",
  last_30_days: "none",
  this_month: "none",
  has_key: "one",
  json_contains: "one",
  json_path_eq: "path",
  array_contains: "list",
  array_overlaps: "list",
  array_is_empty: "none",
  is_null: "none",
  is_not_null: "none",
};

const text = z.string().max(MAX_ROW_FILTER_VALUE_CHARS);

/** A condition as it travels: only the fields its operator takes, and the group it belongs to. */
export const rowFilterShapeFields = {
  column: z.string().min(1).max(255),
  op: z.enum(ROW_FILTER_OPERATORS),
  value: text.optional(),
  values: z.array(text).max(MAX_ROW_FILTER_VALUES).optional(),
  path: z
    .array(z.string().max(MAX_ROW_FILTER_PATH_CHARS))
    .min(1)
    .max(MAX_ROW_FILTER_PATH)
    .optional(),
  group: z.number().int().min(1).max(MAX_ROW_FILTER_GROUPS).optional(),
};

/**
 * One condition, strict: a column, an operator from the fixed list, and exactly the fields that operator
 * takes. Whether the column allows the operator, and whether it is hidden, is decided later against the
 * table, by the adapter.
 */
export const rowFilterSchema = z
  .strictObject(rowFilterShapeFields)
  .superRefine((filter, context) => {
    const shape = ROW_FILTER_SHAPE[filter.op];
    const wantsValue = shape === "one" || shape === "path";
    const wantsValues = shape === "list" || shape === "two";
    const wantsPath = shape === "path";
    const complain = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (wantsValue !== (filter.value !== undefined)) {
      complain(
        "value",
        wantsValue ? "This condition needs a value." : "This condition takes no value.",
      );
    }
    if (wantsValues !== (filter.values !== undefined)) {
      complain(
        "values",
        wantsValues ? "This condition needs a list." : "This condition takes no list.",
      );
    } else if (filter.values !== undefined) {
      if (shape === "two" ? filter.values.length !== 2 : filter.values.length === 0) {
        complain(
          "values",
          shape === "two" ? "This condition needs two values." : "The list is empty.",
        );
      }
    }
    if (wantsPath !== (filter.path !== undefined)) {
      complain(
        "path",
        wantsPath ? "This condition needs a path." : "This condition takes no path.",
      );
    }
  });
