import { describe, expect, it } from "vitest";
import { DatabaseError } from "./errors.js";
import { IMPORT_MAX_ROWS } from "./changes.js";
import {
  IssueCollector,
  NOTE_TEXT,
  VALIDATE_MAX_COLUMNS,
  VALIDATE_MAX_ROWS,
  VALIDATE_MAX_VALUE_CHARS,
  VALIDATE_ROWS_LISTED,
  buildReport,
  checkValidateRequest,
  describeIssue,
  type ValidateRequest,
  type ValidationNote,
  type ValidationRule,
} from "./validation.js";

const table = { schema: "public", name: "t" };
const insert = (over: Partial<ValidateRequest> = {}): ValidateRequest => ({
  table,
  mode: "insert",
  columns: ["a", "b"],
  rows: [["1", null]],
  ...over,
});
const refused = (request: ValidateRequest) => {
  try {
    checkValidateRequest(request);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toBe("invalid_request");
    return true;
  }
  return false;
};

describe("checkValidateRequest", () => {
  it("accepts an insert, an insert of nothing but defaults, and an update with its key", () => {
    expect(refused(insert())).toBe(false);
    expect(refused(insert({ columns: [], rows: [[]] }))).toBe(false);
    expect(
      refused({
        table,
        mode: "update",
        columns: ["a"],
        rows: [["x"]],
        key: [{ column: "id", value: "1" }],
      }),
    ).toBe(false);
  });

  it("accepts as many rows as one import takes", () => {
    expect(
      refused(insert({ rows: Array.from({ length: VALIDATE_MAX_ROWS }, () => ["1", "2"]) })),
    ).toBe(false);
    expect(VALIDATE_MAX_ROWS).toBeGreaterThanOrEqual(IMPORT_MAX_ROWS);
  });

  it.each([
    ["a column twice", insert({ columns: ["a", "a"], rows: [["1", "2"]] })],
    ["a row of the wrong length", insert({ rows: [["1"]] })],
    ["no rows", insert({ rows: [] })],
    [
      "too many rows",
      insert({ rows: Array.from({ length: VALIDATE_MAX_ROWS + 1 }, () => ["1", "2"]) }),
    ],
    [
      "too many columns",
      insert({
        columns: Array.from({ length: VALIDATE_MAX_COLUMNS + 1 }, (_, i) => `c${i}`),
        rows: [Array.from({ length: VALIDATE_MAX_COLUMNS + 1 }, () => "x")],
      }),
    ],
    [
      "a value that is too long",
      insert({ rows: [["x".repeat(VALIDATE_MAX_VALUE_CHARS + 1), null]] }),
    ],
    ["a value that is not text", insert({ rows: [[5 as unknown as string, null]] })],
    ["a key on an insert", insert({ key: [{ column: "id", value: "1" }] })],
    [
      "an update without a key",
      { ...insert(), mode: "update", rows: [["1", "2"]] } as ValidateRequest,
    ],
    [
      "an update of two rows",
      {
        ...insert(),
        mode: "update",
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
        key: [{ column: "id", value: "1" }],
      } as ValidateRequest,
    ],
    [
      "an update that sets nothing",
      {
        table,
        mode: "update",
        columns: [],
        rows: [[]],
        key: [{ column: "id", value: "1" }],
      } as ValidateRequest,
    ],
    [
      "an update with a key column twice",
      {
        table,
        mode: "update",
        columns: ["a"],
        rows: [["1"]],
        key: [
          { column: "id", value: "1" },
          { column: "id", value: "2" },
        ],
      } as ValidateRequest,
    ],
    ["a mode that does not exist", { ...insert(), mode: "delete" } as unknown as ValidateRequest],
  ])("refuses %s, with a fixed code", (_name, request) => {
    expect(refused(request)).toBe(true);
  });
});

describe("IssueCollector and buildReport", () => {
  it("groups failures by rule, column and constraint, counts every row, lists the first few", () => {
    const collector = new IssueCollector();
    for (let row = 1; row <= 30; row++) collector.add("check", null, "price_ok", row);
    collector.add("not_null", "name", null, 5);
    const issues = collector.issues();
    const check = issues.find((i) => i.rule === "check")!;
    expect(check.count).toBe(30);
    expect(check.rows).toHaveLength(VALIDATE_ROWS_LISTED);
    expect(check.rows[0]).toBe(1);
    // A row that broke two rules is one failing row.
    expect(collector.failedRows).toBe(30);
    expect(buildReport(40, collector, []).passed).toBe(10);
  });

  it("adds a counted batch from a query, keeping the rows sorted and not repeating one", () => {
    const collector = new IssueCollector();
    collector.addMany("unique_existing", null, "k", 3, [9, 2, 2]);
    collector.addMany("unique_existing", null, "k", 0, []);
    expect(collector.issues()).toEqual([
      { rule: "unique_existing", column: null, constraint: "k", count: 3, rows: [2, 9] },
    ]);
  });

  it("orders issues by their first row, and lists each note once", () => {
    const collector = new IssueCollector();
    collector.add("type", "b", null, 7);
    collector.add("not_null", "a", null, 2);
    const report = buildReport(10, collector, ["triggers", "triggers", "row_level_security"]);
    expect(report.issues.map((i) => i.rule)).toEqual(["not_null", "type"]);
    expect(report.notChecked).toEqual(["triggers", "row_level_security"]);
  });
});

describe("the words", () => {
  const rules: ValidationRule[] = [
    "not_null",
    "check",
    "type",
    "unique_in_request",
    "unique_existing",
    "foreign_key",
    "no_effects",
    "rejected",
  ];

  it("describes every rule with the names of the structure, and has no place for a value", () => {
    for (const rule of rules) {
      const text = describeIssue({
        rule,
        column: "price",
        constraint: "price_ok",
        count: 1,
        rows: [1],
      });
      expect(text.length).toBeGreaterThan(10);
      expect(text.endsWith(".") || text.endsWith(")")).toBe(true);
    }
    expect(
      describeIssue({ rule: "not_null", column: "name", constraint: null, count: 1, rows: [1] }),
    ).toBe('"name" cannot be NULL.');
    expect(
      describeIssue({ rule: "type", column: null, constraint: null, count: 1, rows: [1] }),
    ).toMatch(/does not fit/);
  });

  it("has a sentence for every note", () => {
    const notes = Object.keys(NOTE_TEXT) as ValidationNote[];
    expect(notes.length).toBeGreaterThanOrEqual(10);
    for (const note of notes) expect(NOTE_TEXT[note].length).toBeGreaterThan(20);
  });
});
