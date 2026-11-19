import { describe, expect, it } from "vitest";
import { elapsedText, failureTitle, lineColumn, resultSummary, rowsText } from "./result-text";

const result = (over: Partial<Parameters<typeof resultSummary>[0]> = {}) => ({
  columns: [],
  rows: [["a"], ["b"]],
  truncated: false,
  command: "SELECT",
  cutCells: 0,
  elapsedMs: 12.4,
  ...over,
});

describe("rowsText", () => {
  it("counts in the singular and the plural", () => {
    expect(rowsText(0)).toBe("0 rows");
    expect(rowsText(1)).toBe("1 row");
    expect(rowsText(1000)).toBe("1,000 rows");
  });
});

describe("resultSummary", () => {
  it("names the rows and the time", () => {
    expect(resultSummary(result())).toEqual(["2 rows", "12 ms"]);
  });

  it("says when rows were left unread and when values were cut", () => {
    expect(resultSummary(result({ truncated: true, cutCells: 1 }))).toEqual([
      "2 rows",
      "Only the first 2 rows are shown; the rest was not read",
      "1 value was cut",
      "12 ms",
    ]);
    expect(resultSummary(result({ cutCells: 3 }))[1]).toBe("3 values were cut");
  });
});

describe("elapsedText", () => {
  it("is seconds, then minutes", () => {
    expect(elapsedText(400)).toBe("0.4 s");
    expect(elapsedText(12_000)).toBe("12.0 s");
    expect(elapsedText(65_000)).toBe("1 min 5 s");
  });
});

describe("lineColumn", () => {
  it("finds the line and column of a position", () => {
    expect(lineColumn("SELECT 1", 1)).toEqual({ line: 1, column: 1 });
    expect(lineColumn("SELECT 1", 8)).toEqual({ line: 1, column: 8 });
    expect(lineColumn("SELECT 1\nFROM x", 15)).toEqual({ line: 2, column: 6 });
  });

  it("stays sensible for a position outside the text", () => {
    expect(lineColumn("abc", 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn("abc", 99)).toEqual({ line: 1, column: 4 });
  });
});

describe("failureTitle", () => {
  it("says what kind of stop it was", () => {
    expect(failureTitle({ code: "not_allowed", message: "", position: null })).toMatch(
      /cannot be run/,
    );
    expect(failureTitle({ code: "cancelled", message: "", position: null })).toMatch(/cancelled/);
    expect(failureTitle({ code: "57014", message: "", position: null })).toMatch(/stopped/);
    expect(failureTitle({ code: "42P01", message: "", position: null })).toMatch(/refused/);
  });
});
