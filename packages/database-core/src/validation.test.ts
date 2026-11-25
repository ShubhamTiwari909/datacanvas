import { describe, expect, it } from "vitest";
import { DatabaseError } from "./errors.js";
import { IMPORT_MAX_ROWS } from "./changes.js";
import {
  IssueCollector,
  NOTE_TEXT,
  VALIDATE_LIST_ALL_MAX_FAILURES,
  VALIDATE_MAX_COLUMNS,
  VALIDATE_MAX_FAILURES_FOUND,
  VALIDATE_MAX_ROWS,
  VALIDATE_MAX_VALUE_CHARS,
  VALIDATE_ROWS_LISTED,
  buildReport,
  checkValidateRequest,
  describeIssue,
  validationLimits,
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
    [
      "listAll on an update",
      {
        table,
        mode: "update",
        columns: ["a"],
        rows: [["1"]],
        key: [{ column: "id", value: "1" }],
        listAll: true,
      } as ValidateRequest,
    ],
    [
      "listAll: false on an update",
      {
        table,
        mode: "update",
        columns: ["a"],
        rows: [["1"]],
        key: [{ column: "id", value: "1" }],
        listAll: false,
      } as ValidateRequest,
    ],
    ["a listAll that is not a boolean", insert({ listAll: "yes" as unknown as boolean })],
    [
      "upsertKey on an update",
      {
        table,
        mode: "update",
        columns: ["a"],
        rows: [["1"]],
        key: [{ column: "id", value: "1" }],
        upsertKey: ["a"],
      } as ValidateRequest,
    ],
    ["an empty upsertKey", insert({ upsertKey: [] })],
    ["an upsertKey that is not a list", insert({ upsertKey: "a" as unknown as string[] })],
    ["an upsertKey that is null", insert({ upsertKey: null as unknown as string[] })],
    ["an upsertKey with a number", insert({ upsertKey: [1] as unknown as string[] })],
    ["an upsertKey naming a column twice", insert({ upsertKey: ["a", "a"] })],
    ["an upsertKey naming a column not given", insert({ upsertKey: ["c"] })],
    [
      "an upsertKey of more than 32 columns",
      (() => {
        const columns = Array.from({ length: 33 }, (_, i) => `c${i}`);
        return insert({ columns, rows: [columns.map(() => "1")], upsertKey: columns });
      })(),
    ],
  ])("refuses %s, with a fixed code", (_name, request) => {
    expect(refused(request)).toBe(true);
  });

  it("accepts listAll on an insert", () => {
    expect(refused(insert({ listAll: true }))).toBe(false);
    expect(refused(insert({ listAll: false }))).toBe(false);
  });

  it("accepts an upsertKey on an insert, alone or with listAll", () => {
    expect(refused(insert({ upsertKey: ["a"] }))).toBe(false);
    expect(refused(insert({ upsertKey: ["b", "a"], listAll: true }))).toBe(false);
    const columns = Array.from({ length: 32 }, (_, i) => `c${i}`);
    expect(refused(insert({ columns, rows: [columns.map(() => "1")], upsertKey: columns }))).toBe(
      false,
    );
  });
});

describe("validationLimits", () => {
  it("keeps the usual limits without listAll, and lists up to the limit with it", () => {
    const usual = {
      stopAfter: VALIDATE_MAX_FAILURES_FOUND,
      rowsListed: VALIDATE_ROWS_LISTED,
      mostListed: null,
    };
    expect(validationLimits({})).toEqual(usual);
    expect(validationLimits({ listAll: false })).toEqual(usual);
    expect(validationLimits({ listAll: true })).toEqual({
      stopAfter: VALIDATE_LIST_ALL_MAX_FAILURES + 1,
      rowsListed: VALIDATE_LIST_ALL_MAX_FAILURES,
      mostListed: VALIDATE_LIST_ALL_MAX_FAILURES,
    });
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

  it("lists as many rows as it is told to", () => {
    const collector = new IssueCollector(VALIDATE_LIST_ALL_MAX_FAILURES);
    for (let row = 1; row <= 1200; row++) collector.add("check", null, "price_ok", row);
    collector.addMany(
      "unique_existing",
      null,
      "k",
      1100,
      Array.from({ length: 1000 }, (_, i) => i + 1),
    );
    const [check, unique] = collector.issues();
    expect(check!.rows).toHaveLength(VALIDATE_LIST_ALL_MAX_FAILURES);
    expect(check!.count).toBe(1200);
    expect(unique!.rows).toHaveLength(VALIDATE_LIST_ALL_MAX_FAILURES);
    expect(collector.mostFailedRows).toBe(1300);
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
