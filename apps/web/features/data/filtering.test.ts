import {
  ROWS_MAX_FILTER_VALUE_CHARS,
  type RowColumn,
  type RowFilter,
} from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  FILTER_OP_LABELS,
  canAddFilter,
  defaultOperator,
  describeFilter,
  describeFilters,
  filterableColumns,
  makeFilter,
  needsValue,
  operatorsFor,
  valueHint,
} from "./filtering";

const col = (name: string, kind: RowColumn["kind"], masked = false, dataType = "x"): RowColumn => ({
  name,
  dataType,
  masked,
  kind,
});
const text = col("name", "text", false, "text");
const number = col("score", "ordered", false, "integer");
const json = col("data", "other", false, "jsonb");
const hidden = col("password", "text", true);

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
  it("offers a text column everything, in a fixed order", () => {
    expect(operatorsFor(text)).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "contains",
      "starts_with",
      "is_null",
      "is_not_null",
    ]);
  });

  it("offers an ordered column the comparisons and the null tests, but not contains or starts with", () => {
    expect(operatorsFor(number)).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "is_null",
      "is_not_null",
    ]);
  });

  it("offers a column with no useful order only the null tests, and nothing for no column", () => {
    expect(operatorsFor(json)).toEqual(["is_null", "is_not_null"]);
    expect(operatorsFor(undefined)).toEqual([]);
  });

  it("starts at equals, or at the first test the column has", () => {
    expect(defaultOperator(text)).toBe("eq");
    expect(defaultOperator(json)).toBe("is_null");
  });

  it("has a word for every condition", () => {
    expect(Object.keys(FILTER_OP_LABELS).sort()).toEqual([...operatorsFor(text)].sort());
    expect(FILTER_OP_LABELS.is_null).toBe("is NULL");
    expect(FILTER_OP_LABELS.neq).toBe("does not equal");
  });

  it("knows which need a value", () => {
    expect(needsValue("eq")).toBe(true);
    expect(needsValue("contains")).toBe(true);
    expect(needsValue("is_null")).toBe(false);
    expect(needsValue("is_not_null")).toBe(false);
  });

  it("hints at what to type", () => {
    expect(valueHint(text, "contains")).toMatch(/any case/);
    expect(valueHint(text, "eq")).toMatch(/exactly/);
    expect(valueHint(number, "gt")).toBe("A value of type integer");
    expect(valueHint(undefined, "eq")).toBe("");
  });
});

describe("whether a condition can be added", () => {
  const one: RowFilter = { column: "name", op: "eq", value: "a" };

  it("can when the column, the condition and the value are right", () => {
    expect(canAddFilter([], { column: text, op: "contains", value: "ann" })).toEqual({ ok: true });
    expect(canAddFilter([one, one], { column: number, op: "gte", value: "3" })).toEqual({
      ok: true,
    });
  });

  it("needs no value for a test for NULL", () => {
    expect(canAddFilter([], { column: json, op: "is_null", value: "" })).toEqual({ ok: true });
  });

  it("allows the empty string for a text column (rows whose text is empty), and never for another type", () => {
    expect(canAddFilter([], { column: text, op: "eq", value: "" })).toEqual({ ok: true });
    expect(canAddFilter([], { column: number, op: "eq", value: "" })).toEqual({
      ok: false,
      reason: "Type a value.",
    });
  });

  it("stops at three, and says so", () => {
    const result = canAddFilter([one, one, one], { column: text, op: "eq", value: "a" });
    expect(result).toEqual({
      ok: false,
      reason: "At most 3 filters at a time. Remove one to add another.",
    });
  });

  it("refuses a value over the limit, a missing column, and a condition the column does not have", () => {
    expect(
      canAddFilter([], {
        column: text,
        op: "eq",
        value: "v".repeat(ROWS_MAX_FILTER_VALUE_CHARS + 1),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("200") });
    expect(
      canAddFilter([], { column: text, op: "eq", value: "v".repeat(ROWS_MAX_FILTER_VALUE_CHARS) }),
    ).toEqual({ ok: true });
    expect(canAddFilter([], { column: undefined, op: "eq", value: "a" })).toEqual({
      ok: false,
      reason: "Choose a column.",
    });
    expect(canAddFilter([], { column: number, op: "contains", value: "1" })).toMatchObject({
      ok: false,
    });
    expect(canAddFilter([], { column: json, op: "eq", value: "x" })).toMatchObject({ ok: false });
  });
});

describe("the condition as the request carries it", () => {
  it("has a value when the condition needs one, and none when it does not", () => {
    expect(makeFilter(text, "contains", "ann")).toEqual({
      column: "name",
      op: "contains",
      value: "ann",
    });
    expect(makeFilter(text, "eq", "")).toEqual({ column: "name", op: "eq", value: "" });
    expect(makeFilter(json, "is_null", "left over from before")).toEqual({
      column: "data",
      op: "is_null",
    });
    expect("value" in makeFilter(json, "is_not_null", "x")).toBe(false);
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

  it("has no value for the tests for NULL", () => {
    expect(describeFilter({ column: "deleted_at", op: "is_null" })).toBe("deleted_at is NULL");
    expect(describeFilter({ column: "deleted_at", op: "is_not_null" })).toBe(
      "deleted_at is not NULL",
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
