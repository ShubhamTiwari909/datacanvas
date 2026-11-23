import {
  IMPORT_MAX_CELL_CHARS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
} from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { decodeUtf8, detectDelimiter, parseCsv, refusalText, type Delimiter } from "./csv-parse";

const rowsOf = (text: string, d: Delimiter = ","): string[][] => {
  const parsed = parseCsv(text, d);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal} at ${parsed.row}`);
  return parsed.rows;
};
const refusal = (text: string, d: Delimiter = ",") => {
  const parsed = parseCsv(text, d);
  return parsed.ok ? null : { refusal: parsed.refusal, row: parsed.row };
};

describe("decodeUtf8", () => {
  const bytes = (...n: number[]) => new Uint8Array(n);
  it("reads UTF-8 with or without a byte order mark, and drops the mark", () => {
    expect(decodeUtf8(new TextEncoder().encode("a,é,日本\n"))).toEqual({
      ok: true,
      text: "a,é,日本\n",
    });
    expect(decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62))).toEqual({
      ok: true,
      text: "a,b",
    });
  });

  it("refuses text in another encoding instead of guessing", () => {
    // "é" in Latin-1, and in UTF-16 with its mark.
    expect(decodeUtf8(bytes(0x61, 0x2c, 0xe9, 0x0a))).toEqual({ ok: false, refusal: "not_utf8" });
    expect(decodeUtf8(bytes(0xff, 0xfe, 0x61, 0x00))).toEqual({ ok: false, refusal: "not_utf8" });
    expect(decodeUtf8(bytes(0xc0, 0xaf))).toEqual({ ok: false, refusal: "not_utf8" });
  });
});

describe("parseCsv", () => {
  it("reads rows and fields, with any kind of line break and with or without one at the end", () => {
    expect(rowsOf("a,b\n1,2\n3,4\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(rowsOf("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(rowsOf("a,b\r1,2\r")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("reads quotes, doubled quotes, delimiters and line breaks inside quotes", () => {
    const text =
      'id,note\n1,"say ""hi"", ok"\n2,"line one\nline two\r\nline three"\n3,"""quoted"""\n';
    expect(rowsOf(text)).toEqual([
      ["id", "note"],
      ["1", 'say "hi", ok'],
      ["2", "line one\nline two\r\nline three"],
      ["3", '"quoted"'],
    ]);
  });

  it("keeps an empty field empty, a quoted empty field empty, and white space as written", () => {
    expect(rowsOf('a,b,c\n1,,3\n,"",\n  x  ,\t,y\n')).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
      ["", "", ""],
      ["  x  ", "\t", "y"],
    ]);
  });

  it("treats a quote in the middle of an unquoted field as a quote", () => {
    expect(rowsOf('a,b\n5" pipe,x\n')).toEqual([
      ["a", "b"],
      ['5" pipe', "x"],
    ]);
  });

  it("reads the other delimiters, and a value that holds the delimiter only when it is quoted", () => {
    expect(rowsOf("a;b\n1;2", ";")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(rowsOf("a\tb\n1\t2,3", "\t")).toEqual([
      ["a", "b"],
      ["1", "2,3"],
    ]);
    expect(rowsOf('a|b\n"x|y"|z', "|")).toEqual([
      ["a", "b"],
      ["x|y", "z"],
    ]);
  });

  it("skips a line with no characters, and keeps a last empty field after a delimiter at the end", () => {
    expect(rowsOf("a,b\n\n1,2\n\n\n3,4\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(rowsOf("a,b\n1,")).toEqual([
      ["a", "b"],
      ["1", ""],
    ]);
  });

  it("reads one column, where an empty line is not a row but a quoted empty value is", () => {
    expect(rowsOf('a\nx\n""\ny\n')).toEqual([["a"], ["x"], [""], ["y"]]);
  });

  it("refuses a row with a different number of fields, naming the row (a quoted line break does not count as a row)", () => {
    expect(refusal("a,b\n1,2\n3\n")).toEqual({ refusal: "ragged", row: 3 });
    expect(refusal("a,b\n1,2,3\n")).toEqual({ refusal: "ragged", row: 2 });
    expect(refusal('a,b\n"one\ntwo",2\n3\n')).toEqual({ refusal: "ragged", row: 4 });
  });

  it("refuses a quote that is never closed, and a character after a closing quote", () => {
    expect(refusal('a,b\n1,"never closed\n3,4\n')).toEqual({ refusal: "quote_open", row: 2 });
    expect(refusal('a,b\n1,"ok"x\n')).toEqual({ refusal: "after_quote", row: 2 });
    expect(refusal('a,b\n"ok" ,2\n')).toEqual({ refusal: "after_quote", row: 2 });
  });

  it("refuses a NUL character, an empty file and a file of nothing but white space", () => {
    expect(refusal("a,b\n1,x\u0000y\n")).toEqual({ refusal: "nul", row: 2 });
    expect(refusal("")).toEqual({ refusal: "empty", row: undefined });
    expect(refusal(" \n\r\n ")).toEqual({ refusal: "empty", row: undefined });
  });

  it("refuses a value that is too long, too many columns and too many rows", () => {
    expect(refusal(`a\n${"x".repeat(IMPORT_MAX_CELL_CHARS + 1)}\n`)).toEqual({
      refusal: "cell_too_long",
      row: 2,
    });
    expect(rowsOf(`a\n${"x".repeat(IMPORT_MAX_CELL_CHARS)}\n`)[1]![0]).toHaveLength(
      IMPORT_MAX_CELL_CHARS,
    );
    const wide = Array.from({ length: IMPORT_MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join(",");
    expect(refusal(`${wide}\n`)).toEqual({ refusal: "too_many_columns", row: 1 });
    const tall = (n: number) => `a\n${Array.from({ length: n }, (_, i) => String(i)).join("\n")}\n`;
    expect(rowsOf(tall(IMPORT_MAX_ROWS))).toHaveLength(IMPORT_MAX_ROWS + 1); // the header and every row
    expect(refusal(tall(IMPORT_MAX_ROWS + 1))).toEqual({
      refusal: "too_many_rows",
      row: undefined,
    });
  });

  it("never reads a value as anything but text: formulas, JSON, NULL and numbers stay as written", () => {
    expect(rowsOf('a,b,c,d\n=1+1,"{""k"": 1}",NULL,007\n')[1]).toEqual([
      "=1+1",
      '{"k": 1}',
      "NULL",
      "007",
    ]);
  });

  it("reads a hostile file without hanging: a million quotes, a long run of delimiters, deep nesting of nothing", () => {
    const started = Date.now();
    expect(refusal('"'.repeat(1_000_001))).toBeTruthy();
    expect(refusal(`a\n"${'""'.repeat(500_000)}`)).toEqual({ refusal: "quote_open", row: 2 });
    expect(refusal(",".repeat(500_000))).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reads 100,000 rows of a realistic file quickly", () => {
    const body = Array.from(
      { length: IMPORT_MAX_ROWS },
      (_, i) => `${i},n${i % 1000},"a note, with a comma ${i}",${i % 7}`,
    ).join("\n");
    const started = Date.now();
    const rows = rowsOf(`id,name,note,qty\n${body}\n`);
    expect(rows).toHaveLength(IMPORT_MAX_ROWS + 1);
    expect(rows[IMPORT_MAX_ROWS]).toEqual([
      String(IMPORT_MAX_ROWS - 1),
      `n${(IMPORT_MAX_ROWS - 1) % 1000}`,
      `a note, with a comma ${IMPORT_MAX_ROWS - 1}`,
      String((IMPORT_MAX_ROWS - 1) % 7),
    ]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("detectDelimiter", () => {
  it("finds the delimiter that is on every line the same number of times", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3\n")).toBe("|");
  });

  it("ignores delimiters inside quotes, prefers the one that splits more, and falls back to a comma", () => {
    expect(detectDelimiter('a;b\n"x,y,z";2\n"p,q";3\n')).toBe(";");
    expect(detectDelimiter("a,b;c\n1,2;3\n")).toBe(",");
    expect(detectDelimiter("a,b;c\n1,2,3;4\n")).toBe(";");
    expect(detectDelimiter("plain\nlines\n")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });
});

describe("refusalText", () => {
  it("has a sentence for every refusal, naming the row when there is one and never a value", () => {
    expect(refusalText("ragged", 12)).toContain("row 12");
    expect(refusalText("quote_open", 3)).toContain("(row 3)");
    expect(refusalText("empty")).not.toContain("row");
    for (const r of [
      "not_utf8",
      "empty",
      "nul",
      "quote_open",
      "after_quote",
      "ragged",
      "cell_too_long",
      "too_many_rows",
      "too_many_columns",
    ] as const) {
      expect(refusalText(r, 1).length).toBeGreaterThan(15);
    }
  });
});

describe("a blank line", () => {
  it("is an empty value in a file of one column, between rows (skipping it would lose a row without a word)", () => {
    expect(rowsOf("name\nAnn\n\nBo\n")).toEqual([["name"], ["Ann"], [""], ["Bo"]]);
    expect(rowsOf("name\r\nAnn\r\n\r\n\r\nBo")).toEqual([["name"], ["Ann"], [""], [""], ["Bo"]]);
  });

  it("is still nothing at the start and the end of the file, and in a file of several columns", () => {
    expect(rowsOf("\n\nname\nAnn\n\n\n")).toEqual([["name"], ["Ann"]]);
    expect(rowsOf("a,b\n1,2\n\n3,4\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});
