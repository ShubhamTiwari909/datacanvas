/** Conditions on rows: their shape, which operators each kind of column allows, and what is refused. */
import { describe, expect, it } from "vitest";
import {
  ROWS_MAX_FILTER_VALUE_CHARS,
  ROWS_MAX_FILTERS,
  ROW_FILTER_OPS,
  type RowColumn,
  type RowFilter,
} from "./models.js";
import { buildRowPage, checkRowsFilters, filterOpsFor, normalizeRowsOptions } from "./rows.js";

const base = { pageSize: 10, cursor: null, revealColumns: [] };
const refused = /paging position/;

describe("conditions in the options", () => {
  it("are an empty list when absent or empty, and are read as given otherwise", () => {
    expect(normalizeRowsOptions(base).filters).toEqual([]);
    expect(normalizeRowsOptions({ ...base, filters: [] }).filters).toEqual([]);
    const filters: RowFilter[] = [
      { column: "name", op: "contains", value: "ann" },
      { column: "score", op: "gte", value: "5" },
      { column: "born", op: "is_null" },
    ];
    expect(normalizeRowsOptions({ ...base, filters }).filters).toEqual(filters);
  });

  it("allow an empty value, which is a value (the empty string), and every operator by name", () => {
    expect(
      normalizeRowsOptions({ ...base, filters: [{ column: "a", op: "eq", value: "" }] }).filters,
    ).toEqual([{ column: "a", op: "eq", value: "" }]);
    for (const op of ROW_FILTER_OPS) {
      const nullary = op === "is_null" || op === "is_not_null";
      const filter: RowFilter = nullary ? { column: "a", op } : { column: "a", op, value: "x" };
      expect(normalizeRowsOptions({ ...base, filters: [filter] }).filters).toEqual([filter]);
    }
  });

  it(`allow at most ${ROWS_MAX_FILTERS}, and a value of at most ${ROWS_MAX_FILTER_VALUE_CHARS} characters`, () => {
    const one: RowFilter = { column: "a", op: "eq", value: "x" };
    expect(
      normalizeRowsOptions({ ...base, filters: Array(ROWS_MAX_FILTERS).fill(one) }).filters,
    ).toHaveLength(ROWS_MAX_FILTERS);
    expect(() =>
      normalizeRowsOptions({ ...base, filters: Array(ROWS_MAX_FILTERS + 1).fill(one) }),
    ).toThrow(refused);
    const long = "v".repeat(ROWS_MAX_FILTER_VALUE_CHARS);
    expect(
      normalizeRowsOptions({ ...base, filters: [{ ...one, value: long }] }).filters[0]!.value,
    ).toBe(long);
    expect(() =>
      normalizeRowsOptions({ ...base, filters: [{ ...one, value: long + "v" }] }),
    ).toThrow(refused);
  });

  it.each([
    ["not a list", { column: "a", op: "eq", value: "x" }],
    ["an item that is not an object", ["a"]],
    ["an item that is a list", [[]]],
    ["an item that is null", [null]],
    ["an unknown operator", [{ column: "a", op: "like", value: "x" }]],
    ["an operator that is not text", [{ column: "a", op: 1, value: "x" }]],
    ["an empty column name", [{ column: "", op: "eq", value: "x" }]],
    ["a column name over 255 characters", [{ column: "c".repeat(256), op: "eq", value: "x" }]],
    ["a column that is not text", [{ column: 7, op: "eq", value: "x" }]],
    ["a missing value", [{ column: "a", op: "eq" }]],
    ["a value that is not text", [{ column: "a", op: "eq", value: 5 }]],
    ["a value with a NUL character", [{ column: "a", op: "eq", value: "a\u0000b" }]],
    ["a value on is_null", [{ column: "a", op: "is_null", value: "x" }]],
    ["a value on is_not_null", [{ column: "a", op: "is_not_null", value: "" }]],
    ["an extra key", [{ column: "a", op: "eq", value: "x", where: "1=1" }]],
  ])("refuse %s", (_name, filters) => {
    expect(() => normalizeRowsOptions({ ...base, filters } as never)).toThrow(refused);
  });

  it("never repeat a value or a name in the refusal", () => {
    try {
      normalizeRowsOptions({
        ...base,
        filters: [{ column: "SECRET-COLUMN", op: "like", value: "SECRET-VALUE" } as never],
      });
      expect.unreachable();
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain("SECRET-COLUMN");
      expect(message).not.toContain("SECRET-VALUE");
    }
  });
});

describe("which operators a column allows", () => {
  it("text allows everything, ordered everything but contains and starts with, other only the null tests", () => {
    expect(new Set(filterOpsFor("text"))).toEqual(new Set(ROW_FILTER_OPS));
    expect(new Set(filterOpsFor("ordered"))).toEqual(
      new Set(ROW_FILTER_OPS.filter((op) => op !== "contains" && op !== "starts_with")),
    );
    expect([...filterOpsFor("other")]).toEqual(["is_null", "is_not_null"]);
  });
});

describe("checking conditions against the columns", () => {
  const col = (name: string, kind: RowColumn["kind"], masked = false): RowColumn => ({
    name,
    dataType: "x",
    masked,
    kind,
  });
  const columns = [
    col("id", "ordered"),
    col("name", "text"),
    col("data", "other"),
    col("password", "text", true),
  ];

  it("passes conditions the columns allow, and returns them as given", () => {
    const filters: RowFilter[] = [
      { column: "name", op: "starts_with", value: "a" },
      { column: "id", op: "gt", value: "3" },
      { column: "data", op: "is_not_null" },
    ];
    expect(checkRowsFilters(filters, columns)).toEqual(filters);
    expect(checkRowsFilters([], columns)).toEqual([]);
  });

  it.each([
    ["a column that does not exist", { column: "nope", op: "is_null" }],
    [
      "a hidden column: a condition on it would read it back",
      { column: "password", op: "starts_with", value: "a" },
    ],
    ["a hidden column, even for a null test", { column: "password", op: "is_null" }],
    ["contains on a number", { column: "id", op: "contains", value: "1" }],
    ["starts with on a number", { column: "id", op: "starts_with", value: "1" }],
    [
      "equals on a kind of column that only has null tests",
      { column: "data", op: "eq", value: "x" },
    ],
    [
      "a comparison on a kind of column that only has null tests",
      { column: "data", op: "gt", value: "x" },
    ],
  ])("refuses %s", (_name, filter) => {
    expect(() => checkRowsFilters([filter as RowFilter], columns)).toThrow(refused);
  });

  it("allows a hidden column once it is revealed", () => {
    const revealed = columns.map((c) => (c.name === "password" ? { ...c, masked: false } : c));
    expect(
      checkRowsFilters([{ column: "password", op: "starts_with", value: "a" }], revealed),
    ).toHaveLength(1);
  });

  it("one bad condition among good ones refuses the whole read", () => {
    expect(() =>
      checkRowsFilters(
        [
          { column: "name", op: "eq", value: "a" },
          { column: "password", op: "eq", value: "a" },
        ],
        columns,
      ),
    ).toThrow(refused);
  });
});

describe("a page that was filtered", () => {
  it("echoes the conditions in the order given, and an unfiltered page has none", () => {
    const columns: RowColumn[] = [
      { name: "id", dataType: "integer", masked: false, kind: "ordered" },
    ];
    const filters: RowFilter[] = [
      { column: "id", op: "gt", value: "1" },
      { column: "id", op: "lte", value: "9" },
    ];
    const common = {
      columns,
      hiddenColumns: 0,
      order: { kind: "primary_key" as const, columns: ["id"] },
      rawRows: [],
      pageSize: 5,
      offset: 0,
    };
    expect(buildRowPage({ ...common, filters }).filters).toEqual(filters);
    expect(buildRowPage(common).filters).toEqual([]);
    // The page holds a copy: changing the input afterwards does not change it.
    const page = buildRowPage({ ...common, filters });
    filters.pop();
    expect(page.filters).toHaveLength(2);
  });
});
