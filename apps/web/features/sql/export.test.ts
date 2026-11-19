import { describe, expect, it } from "vitest";
import { csvFile, defuse, planText, toCsv, toJson, toTsv } from "./export";

const cols = (...names: string[]) => names.map((name) => ({ name, dataType: "text" }));

describe("toCsv", () => {
  it("writes a header and the rows, with \\r\\n between lines", () => {
    expect(
      toCsv(cols("id", "v"), [
        ["1", "one"],
        ["2", "two"],
      ]),
    ).toBe("id,v\r\n1,one\r\n2,two");
  });

  it("quotes what needs it and doubles the quotes", () => {
    expect(toCsv(cols("a"), [["x,y"], ['say "hi"'], ["line\nbreak"], [" padded"], ["tail "]])).toBe(
      'a\r\n"x,y"\r\n"say ""hi"""\r\n"line\nbreak"\r\n" padded"\r\n"tail "',
    );
  });

  it("writes NULL as an empty field and the empty string as one too", () => {
    expect(toCsv(cols("a", "b"), [[null, ""]])).toBe("a,b\r\n,");
  });

  it("quotes a header that needs it", () => {
    expect(toCsv(cols("a,b", 'c"d'), [])).toBe('"a,b","c""d"');
  });

  it("has just the header for no rows, and nothing for no columns", () => {
    expect(toCsv(cols("a"), [])).toBe("a");
    expect(toCsv([], [])).toBe("");
  });

  it("puts a byte order mark on a file but not on the text", () => {
    expect(csvFile(cols("a"), [["é"]])).toBe("﻿a\r\né");
    expect(toCsv(cols("a"), [["é"]]).startsWith("﻿")).toBe(false);
  });
});

describe("a value a spreadsheet would run", () => {
  it.each([
    "=1+1",
    "+cmd",
    "-cmd",
    "@SUM(A1)",
    "\tx",
    "\rx",
    "\n=1+1",
    " =1+1",
    "  \t@x",
    "|cmd",
    "\u0001=1",
  ])("is made safe: %j", (value) => {
    expect(defuse(value)).toBe(`'${value}`);
  });

  it.each(["-5", "-5.25", "1e10", "-1.5E-3", "42", "abc", "a=b", ""])(
    "is left alone: %j",
    (value) => {
      expect(defuse(value)).toBe(value);
    },
  );

  it("applies to the rows and the header of every format", () => {
    expect(toCsv(cols("=h"), [["=1+1"]])).toBe("'=h\r\n'=1+1");
    expect(toTsv(cols("a"), [["@x"]])).toBe("a\r\n'@x");
  });

  it("keeps a number a number", () => {
    expect(toCsv(cols("n"), [["-5"], ["1e3"]])).toBe("n\r\n-5\r\n1e3");
  });
});

describe("toTsv", () => {
  it("separates with tabs and quotes what holds a tab, a quote or a line break", () => {
    expect(
      toTsv(cols("a", "b"), [
        ["x", "y"],
        ["has\ttab", 'q"q'],
        ["a,b", "c"],
      ]),
    ).toBe('a\tb\r\nx\ty\r\n"has\ttab"\t"q""q"\r\na,b\tc');
  });
});

describe("toJson", () => {
  it("writes one object per row, NULL as null, values as the text they are", () => {
    expect(
      JSON.parse(
        toJson(cols("id", "v"), [
          ["1", null],
          ["2", "two"],
        ]),
      ),
    ).toEqual([
      { id: "1", v: null },
      { id: "2", v: "two" },
    ]);
  });

  it("keeps repeated column names apart", () => {
    expect(JSON.parse(toJson(cols("id", "id", "id"), [["1", "2", "3"]]))).toEqual([
      { id: "1", "id (2)": "2", "id (3)": "3" },
    ]);
  });

  it("never reuses a key, even when a made-up one is also a column name", () => {
    const parsed = JSON.parse(toJson(cols("id", "id (2)", "id"), [["1", "2", "3"]])) as Record<
      string,
      string
    >[];
    expect(parsed[0]).toEqual({ id: "1", "id (2)": "2", "id (3)": "3" });
  });

  it("treats a column called __proto__ as a name", () => {
    const parsed = JSON.parse(toJson(cols("__proto__"), [["x"]])) as unknown[];
    expect(Object.keys(parsed[0] as object)).toEqual(["__proto__"]);
  });

  it("is an empty list for no rows", () => {
    expect(toJson(cols("a"), [])).toBe("[]");
  });
});

describe("planText", () => {
  it("joins the lines of an explain", () => {
    expect(planText([["Seq Scan on t"], ["  Filter: x"], [null]])).toBe(
      "Seq Scan on t\n  Filter: x\n",
    );
  });
});
