import {
  ROWS_MAX_FILTER_PATH,
  ROWS_MAX_FILTER_VALUE_CHARS,
  ROWS_MAX_FILTER_VALUES,
  ROWS_MAX_FILTERS,
  ROW_FILTER_OPS,
  type RowColumn,
  type RowFilter,
  type RowFilterOp,
} from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  FILTER_OP_LABELS,
  canAddFilter,
  defaultOperator,
  describeFilter,
  describeFilters,
  emptyDraft,
  filterForCell,
  filterableColumns,
  listValues,
  makeFilter,
  needsValue,
  operatorsFor,
  pathSteps,
  shapeOf,
  valueHint,
  type FilterDraft,
} from "./filtering";

const col = (name: string, kind: RowColumn["kind"], masked = false, dataType = "x"): RowColumn => ({
  name,
  dataType,
  masked,
  kind,
});
const text = col("name", "text", false, "text");
const number = col("score", "ordered", false, "integer");
const born = col("born", "ordered", false, "date");
const json = col("data", "json", false, "jsonb");
const tags = col("tags", "array", false, "text[]");
const other = col("loc", "other", false, "point");
const hidden = col("password", "text", true);

/** A draft the way the panel holds it, with only what a test sets. */
const draft = (column: RowColumn | undefined, op: RowFilterOp, set: Partial<FilterDraft> = {}) => ({
  ...emptyDraft(column, op),
  ...set,
});

describe("which columns the panel offers", () => {
  it("is every column that was read except the hidden ones", () => {
    expect(filterableColumns([text, number, json, hidden]).map((c) => c.name)).toEqual([
      "name",
      "score",
      "data",
    ]);
  });
});

describe("which conditions a column offers", () => {
  it("offers a text column the comparisons, the text tests, the lists and the null tests, in a fixed order", () => {
    expect(operatorsFor(text)).toEqual([
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
      "is_null",
      "is_not_null",
    ]);
  });

  it("offers an ordered column the comparisons, lists and null tests, and the date shortcuts for a date", () => {
    expect(operatorsFor(number)).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "not_in",
      "between",
      "is_null",
      "is_not_null",
    ]);
    expect(operatorsFor(born)).toEqual(
      expect.arrayContaining(["today", "last_7_days", "this_month"]),
    );
    expect(operatorsFor(number)).not.toContain("today");
  });

  it("offers json its own tests, arrays theirs, and a column with no useful order only the null tests", () => {
    expect(operatorsFor(json)).toEqual([
      "has_key",
      "json_contains",
      "json_path_eq",
      "is_null",
      "is_not_null",
    ]);
    expect(operatorsFor(tags)).toEqual([
      "array_contains",
      "array_overlaps",
      "array_is_empty",
      "is_null",
      "is_not_null",
    ]);
    expect(operatorsFor(other)).toEqual(["is_null", "is_not_null"]);
    expect(operatorsFor(undefined)).toEqual([]);
  });

  it("starts at equals, or at the first test the column has", () => {
    expect(defaultOperator(text)).toBe("eq");
    expect(defaultOperator(json)).toBe("has_key");
    expect(defaultOperator(other)).toBe("is_null");
  });

  it("has a word for every condition there is", () => {
    expect(Object.keys(FILTER_OP_LABELS).sort()).toEqual([...ROW_FILTER_OPS].sort());
    expect(FILTER_OP_LABELS.is_null).toBe("is NULL");
    expect(FILTER_OP_LABELS.neq).toBe("does not equal");
  });

  it("knows which take a single value, and which take something else", () => {
    for (const op of ["eq", "contains", "matches", "has_key", "json_path_eq"] as const) {
      expect(needsValue(op), op).toBe(true);
    }
    for (const op of ["is_null", "today", "in", "between", "array_is_empty"] as const) {
      expect(needsValue(op), op).toBe(false);
    }
    expect(shapeOf("in")).toBe("list");
    expect(shapeOf("between")).toBe("two");
  });

  it("hints at what to type", () => {
    expect(valueHint(text, "contains")).toMatch(/any case/);
    expect(valueHint(text, "eq")).toMatch(/exactly/);
    expect(valueHint(number, "gt")).toBe("A value of type integer");
    expect(valueHint(text, "matches")).toMatch(/pattern/);
    expect(valueHint(json, "json_contains")).toMatch(/JSON/);
    expect(valueHint(undefined, "eq")).toBe("");
  });
});

describe("whether a condition can be added", () => {
  const one: RowFilter = { column: "name", op: "eq", value: "a" };
  const ok = { ok: true };

  it("can when the column, the condition and the value are right", () => {
    expect(canAddFilter([], draft(text, "contains", { value: "ann" }))).toEqual(ok);
    expect(canAddFilter([one, one], draft(number, "gte", { value: "3" }))).toEqual(ok);
  });

  it("needs no value for a test for NULL or a date shortcut", () => {
    expect(canAddFilter([], draft(json, "is_null"))).toEqual(ok);
    expect(canAddFilter([], draft(born, "last_7_days"))).toEqual(ok);
    expect(canAddFilter([], draft(tags, "array_is_empty"))).toEqual(ok);
  });

  it("allows the empty string for a text column (rows whose text is empty), and never for another type", () => {
    expect(canAddFilter([], draft(text, "eq", { value: "" }))).toEqual(ok);
    expect(canAddFilter([], draft(number, "eq", { value: "" }))).toEqual({
      ok: false,
      reason: "Type a value.",
    });
    expect(canAddFilter([], draft(json, "has_key", { value: "" }))).toMatchObject({ ok: false });
  });

  it(`stops at ${ROWS_MAX_FILTERS}, and says so`, () => {
    expect(
      canAddFilter(Array(ROWS_MAX_FILTERS).fill(one), draft(text, "eq", { value: "a" })),
    ).toEqual({
      ok: false,
      reason: `At most ${ROWS_MAX_FILTERS} filters at a time. Remove one to add another.`,
    });
    expect(
      canAddFilter(Array(ROWS_MAX_FILTERS - 1).fill(one), draft(text, "eq", { value: "a" })),
    ).toEqual(ok);
  });

  it("refuses a value over the limit, a missing column, and a condition the column does not have", () => {
    const long = "v".repeat(ROWS_MAX_FILTER_VALUE_CHARS);
    expect(canAddFilter([], draft(text, "eq", { value: long + "v" }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("200"),
    });
    expect(canAddFilter([], draft(text, "eq", { value: long }))).toEqual(ok);
    expect(canAddFilter([], draft(undefined, "eq", { value: "a" }))).toEqual({
      ok: false,
      reason: "Choose a column.",
    });
    expect(canAddFilter([], draft(number, "contains", { value: "1" }))).toMatchObject({
      ok: false,
    });
    expect(canAddFilter([], draft(json, "eq", { value: "x" }))).toMatchObject({ ok: false });
  });

  it("wants a list of one to fifty values, one per line", () => {
    expect(canAddFilter([], draft(number, "in", { list: "" }))).toMatchObject({ ok: false });
    expect(canAddFilter([], draft(number, "in", { list: "\n\n" }))).toMatchObject({ ok: false });
    expect(canAddFilter([], draft(number, "in", { list: "1\n2" }))).toEqual(ok);
    const many = Array.from({ length: ROWS_MAX_FILTER_VALUES + 1 }, (_, i) => i).join("\n");
    expect(canAddFilter([], draft(number, "in", { list: many }))).toMatchObject({ ok: false });
    expect(canAddFilter([], draft(number, "in", { list: `1\n${"x".repeat(201)}` }))).toMatchObject({
      ok: false,
    });
  });

  it("wants both ends of a range", () => {
    expect(canAddFilter([], draft(number, "between", { low: "1" }))).toMatchObject({ ok: false });
    expect(canAddFilter([], draft(number, "between", { low: "1", high: "5" }))).toEqual(ok);
  });

  it("wants a path and a value for a JSON path, within the limits", () => {
    expect(canAddFilter([], draft(json, "json_path_eq", { value: "x" }))).toMatchObject({
      ok: false,
    });
    expect(canAddFilter([], draft(json, "json_path_eq", { path: "a.b", value: "" }))).toMatchObject(
      { ok: false },
    );
    expect(canAddFilter([], draft(json, "json_path_eq", { path: "a.b", value: "x" }))).toEqual(ok);
    const deep = Array(ROWS_MAX_FILTER_PATH + 1)
      .fill("a")
      .join(".");
    expect(canAddFilter([], draft(json, "json_path_eq", { path: deep, value: "x" }))).toMatchObject(
      { ok: false },
    );
  });
});

describe("the condition as the request carries it", () => {
  it("has only the fields its operator takes", () => {
    expect(makeFilter(text, draft(text, "contains", { value: "ann" }))).toEqual({
      column: "name",
      op: "contains",
      value: "ann",
    });
    expect(makeFilter(text, draft(text, "eq", { value: "" }))).toEqual({
      column: "name",
      op: "eq",
      value: "",
    });
    const stale = { value: "left over", list: "1", low: "a", high: "b", path: "p" };
    expect(makeFilter(json, draft(json, "is_null", stale))).toEqual({
      column: "data",
      op: "is_null",
    });
    expect(makeFilter(number, draft(number, "in", { ...stale, list: "1\n\n2\n" }))).toEqual({
      column: "score",
      op: "in",
      values: ["1", "2"],
    });
    expect(makeFilter(number, draft(number, "between", { low: "1", high: "5" }))).toEqual({
      column: "score",
      op: "between",
      values: ["1", "5"],
    });
    expect(makeFilter(json, draft(json, "json_path_eq", { path: "a..b.", value: "x" }))).toEqual({
      column: "data",
      op: "json_path_eq",
      path: ["a", "b"],
      value: "x",
    });
  });

  it("carries the group only when there is one", () => {
    expect(makeFilter(text, draft(text, "eq", { value: "a", group: 0 }))).not.toHaveProperty(
      "group",
    );
    expect(makeFilter(text, draft(text, "eq", { value: "a", group: 2 }))).toHaveProperty(
      "group",
      2,
    );
  });

  it("reads lines and dotted paths", () => {
    expect(listValues("a\r\nb\rc\n\nd")).toEqual(["a", "b", "c", "d"]);
    expect(pathSteps("a.b.0")).toEqual(["a", "b", "0"]);
  });
});

describe("a filter in words", () => {
  it("reads as the column, the condition and the quoted value", () => {
    expect(describeFilter({ column: "email", op: "contains", value: "ann" })).toBe(
      'email contains "ann"',
    );
    expect(describeFilter({ column: "score", op: "gte", value: "5" })).toBe(
      'score is at least "5"',
    );
    expect(describeFilter({ column: "email", op: "eq", value: "" })).toBe('email equals ""');
  });

  it("has no value for the tests for NULL and the shortcuts", () => {
    expect(describeFilter({ column: "deleted_at", op: "is_null" })).toBe("deleted_at is NULL");
    expect(describeFilter({ column: "born", op: "last_7_days" })).toBe(
      "born is in the last 7 days",
    );
  });

  it("reads a list, a range, a path and a group", () => {
    expect(describeFilter({ column: "score", op: "in", values: ["1", "2"] })).toBe(
      'score is one of "1", "2"',
    );
    expect(describeFilter({ column: "score", op: "between", values: ["1", "5"] })).toBe(
      'score is between "1" and "5"',
    );
    expect(
      describeFilter({ column: "data", op: "json_path_eq", path: ["a", "b"], value: "x" }),
    ).toBe('data at a.b equals "x"');
    expect(describeFilter({ column: "name", op: "eq", value: "a", group: 2 })).toBe(
      'name equals "a" (any of B)',
    );
  });

  it("cuts a long value for display only", () => {
    const shown = describeFilter({ column: "bio", op: "contains", value: "x".repeat(100) });
    expect(shown).toBe(`bio contains "${"x".repeat(40)}…"`);
  });

  it("lists every filter in the order given", () => {
    expect(
      describeFilters([
        { column: "a", op: "eq", value: "1" },
        { column: "b", op: "is_null" },
      ]),
    ).toBe('a equals "1"; b is NULL');
    expect(describeFilters([])).toBe("");
  });
});

describe("filter by this value", () => {
  it("is an equals for text and ordered columns", () => {
    expect(filterForCell(text, "ann", false)).toEqual({ column: "name", op: "eq", value: "ann" });
    expect(filterForCell(number, "5", false)).toEqual({ column: "score", op: "eq", value: "5" });
    expect(filterForCell(text, "", false)).toEqual({ column: "name", op: "eq", value: "" });
  });

  it("is a NULL test for NULL", () => {
    expect(filterForCell(text, null, false)).toEqual({ column: "name", op: "is_null" });
    expect(filterForCell(json, null, false)).toEqual({ column: "data", op: "is_null" });
  });

  it("is nothing for a value that was cut, one too long to be a value, a hidden column or a kind with no equals", () => {
    expect(filterForCell(text, "x", true)).toBeNull();
    expect(filterForCell(text, "x".repeat(201), false)).toBeNull();
    expect(filterForCell(hidden, "x", false)).toBeNull();
    expect(filterForCell(json, "{}", false)).toBeNull();
    expect(filterForCell(tags, "{a}", false)).toBeNull();
  });
});
