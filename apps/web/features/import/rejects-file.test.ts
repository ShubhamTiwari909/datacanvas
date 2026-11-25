import { describe, expect, it } from "vitest";
import { defuse } from "@/features/sql/export";
import { decodeUtf8, parseCsv, type Delimiter } from "./csv-parse";
import type { Reject, RejectReason } from "./leave-out";
import {
  buildRejectsCsv,
  defuseReversible,
  isRejectsHeader,
  reasonsText,
  reasonText,
  REJECTS_COLUMN,
  restoreDefused,
  restoreRejectsRows,
} from "./rejects-file";

/** A small seeded generator (mulberry32), so a failing case can be found again. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The characters that matter to the rule and to CSV, plus a few ordinary ones. */
const PIECES = [
  "'",
  "''",
  "=",
  "+",
  "-",
  "@",
  "|",
  "\t",
  "\r",
  "\n",
  "\r\n",
  " ",
  '"',
  ",",
  ";",
  "1",
  "5",
  ".",
  "e",
  "x",
  "SUM(A1)",
  "é",
  "日本",
  "\u0001",
  "\u001f",
];

function value(next: () => number): string {
  if (next() < 0.1) return "";
  const length = 1 + Math.floor(next() * 6);
  let out = "";
  for (let i = 0; i < length; i++) out += PIECES[Math.floor(next() * PIECES.length)]!;
  return out;
}

const reason = (
  rule: RejectReason["rule"],
  column: string | null = null,
  constraint: string | null = null,
): RejectReason => ({ rule, column, constraint });

describe("defuseReversible and restoreDefused", () => {
  it("writes one more apostrophe in front of what the export's rule defuses, past any apostrophes", () => {
    expect(defuseReversible("=x")).toBe("'=x");
    expect(defuseReversible("'=x")).toBe("''=x");
    expect(defuseReversible("''+1+")).toBe("'''+1+");
    expect(defuseReversible("@sum")).toBe("'@sum");
    expect(defuseReversible("\t=x")).toBe("'\t=x");
    expect(defuseReversible("\r+1")).toBe("'\r+1");
  });

  it("leaves alone what the rule leaves alone, with or without apostrophes", () => {
    for (const v of ["", "plain", "'", "''", "'plain", "-5", "'-5", "1e5", "a=b", "'a=b", " 'x"]) {
      expect(defuseReversible(v)).toBe(v);
      expect(restoreDefused(v)).toBe(v);
    }
  });

  it("removes exactly one apostrophe, only where the rule put one", () => {
    expect(restoreDefused("'=x")).toBe("=x");
    expect(restoreDefused("''=x")).toBe("'=x");
    expect(restoreDefused("'''@a")).toBe("''@a");
    expect(restoreDefused("'plain")).toBe("'plain");
  });

  it("is safe: what the export's rule would defuse always starts with an apostrophe once written", () => {
    const next = random(7);
    for (let i = 0; i < 5000; i++) {
      const written = defuseReversible(value(next));
      expect(written.startsWith("'") || defuse(written) === written).toBe(true);
    }
  });

  it("gives every value back: restoreDefused(defuseReversible(v)) === v", () => {
    const fixed = [
      "",
      "'",
      "''",
      "'''",
      "=",
      "'=",
      "''=",
      "+",
      "-",
      "@",
      "|",
      "\t",
      "\r",
      "\n",
      "'\t",
      "'\r\n=",
      "-5",
      "'-5",
      "-x",
      "'-x",
      " =1",
      "' =1",
      "\u0001=1",
    ];
    for (const v of fixed) expect(restoreDefused(defuseReversible(v))).toBe(v);
    for (const seed of [1, 2, 3, 42, 2026]) {
      const next = random(seed);
      for (let i = 0; i < 4000; i++) {
        const v = value(next);
        expect(restoreDefused(defuseReversible(v)), JSON.stringify(v)).toBe(v);
      }
    }
  });
});

describe("reasonText", () => {
  it("is a fixed sentence with names of the structure only", () => {
    expect(reasonText(reason("unique_in_request", "id", "t_pkey"))).toBe("unique key");
    expect(reasonText(reason("unique_existing", "id", "t_pkey"))).toBe("unique key");
    expect(reasonText(reason("not_null", "qty"))).toBe("NOT NULL of qty");
    expect(reasonText(reason("not_null"))).toBe("NOT NULL");
    expect(reasonText(reason("type", "qty"), new Map([["qty", "integer"]]))).toBe(
      "does not fit integer",
    );
    expect(reasonText(reason("type", "qty"))).toBe("does not fit qty");
    expect(reasonText(reason("type"))).toBe("does not fit its column");
    expect(reasonText(reason("check", "qty", "qty_positive"))).toBe("check qty_positive");
    expect(reasonText(reason("check", "qty"))).toBe("check of qty");
    expect(reasonText(reason("check"))).toBe("check");
    expect(reasonText(reason("foreign_key", "owner", "t_owner_fkey"))).toBe(
      "foreign key t_owner_fkey",
    );
    expect(reasonText(reason("foreign_key"))).toBe("foreign key");
    expect(reasonText(reason("rejected"))).toBe("rejected");
    expect(reasonText(reason("no_effects"))).toBe("rejected");
  });

  it("joins the reasons of a row, each sentence once", () => {
    expect(
      reasonsText([
        reason("unique_in_request", "id"),
        reason("unique_existing", "id"),
        reason("not_null", "qty"),
      ]),
    ).toBe("unique key; NOT NULL of qty");
  });
});

describe("buildRejectsCsv", () => {
  const rejects: Reject[] = [
    { line: 7, row: ["3", "=HYPERLINK(1)", "a,b"], reasons: [reason("not_null", "qty")] },
    { line: 2, row: ["1", 'say "hi"', "two\nlines"], reasons: [reason("unique_existing", "id")] },
  ];

  it("writes a byte order mark, the header with the reserved column, and the rows in the file's order", () => {
    const text = buildRejectsCsv({ header: ["id", "name", "note"], rejects, delimiter: "," });
    expect(text).toBe(
      "\uFEFF" +
        `id,name,note,${REJECTS_COLUMN}\r\n` +
        '1,"say ""hi""","two\nlines",unique key\r\n' +
        '3,\'=HYPERLINK(1),"a,b",NOT NULL of qty\r\n',
    );
  });

  it("uses the file's own delimiter", () => {
    const text = buildRejectsCsv({ header: ["id", "name", "note"], rejects, delimiter: ";" });
    expect(text.split("\r\n")[0]).toBe(`\uFEFFid;name;note;${REJECTS_COLUMN}`);
    expect(text).toContain("3;'=HYPERLINK(1);a,b;NOT NULL of qty");
  });

  it("names the columns when the file had no header", () => {
    const text = buildRejectsCsv({ header: null, rejects, delimiter: "\t" });
    expect(text.split("\r\n")[0]).toBe(`\uFEFFcolumn_1\tcolumn_2\tcolumn_3\t${REJECTS_COLUMN}`);
  });

  it("is UTF-8 with its mark once encoded, whatever the file was read in", () => {
    const bytes = new TextEncoder().encode(
      buildRejectsCsv({ header: ["é"], rejects: [], delimiter: "," }),
    );
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("defuses the reason too, and quotes a name holding the delimiter", () => {
    const text = buildRejectsCsv({
      header: ["a"],
      rejects: [{ line: 2, row: ["x"], reasons: [reason("check", null, "=c,1")] }],
      delimiter: ",",
    });
    expect(text).toContain('x,"check =c,1"');
    const odd = buildRejectsCsv({
      header: ["a"],
      rejects: [{ line: 2, row: ["x"], reasons: [reason("type", "-col")] }],
      delimiter: ",",
    });
    expect(odd).toContain("x,does not fit -col");
  });
});

describe("isRejectsHeader", () => {
  it("is true only for a header ending in the reserved column, after at least one column", () => {
    expect(isRejectsHeader(["id", REJECTS_COLUMN])).toBe(true);
    expect(isRejectsHeader([REJECTS_COLUMN])).toBe(false);
    expect(isRejectsHeader([REJECTS_COLUMN, "id"])).toBe(false);
    expect(isRejectsHeader(["id", "datacanvas_reject_v2"])).toBe(false);
    expect(isRejectsHeader(["id", "Datacanvas_reject_v1"])).toBe(false);
    expect(isRejectsHeader([])).toBe(false);
    expect(isRejectsHeader(undefined)).toBe(false);
  });
});

describe("restoreRejectsRows", () => {
  it("drops the reserved column and takes one apostrophe off where the rule put one", () => {
    expect(
      restoreRejectsRows([
        ["'=h", "b", REJECTS_COLUMN],
        ["''=x", "'plain", "unique key"],
      ]),
    ).toEqual([
      ["=h", "b"],
      ["'=x", "'plain"],
    ]);
  });

  it("changes nothing in a file that is not a rejects file", () => {
    const rows = [
      ["a", "b"],
      ["'=x", "y"],
    ];
    expect(restoreRejectsRows(rows)).toEqual(rows);
  });
});

describe("a rejects file read back", () => {
  const parse = (text: string, delimiter: Delimiter): string[][] => {
    const decoded = decodeUtf8(new TextEncoder().encode(text));
    if (!decoded.ok) throw new Error("not UTF-8");
    const parsed = parseCsv(decoded.text, delimiter);
    if (!parsed.ok) throw new Error(`refused: ${parsed.refusal} at ${parsed.row}`);
    return parsed.rows;
  };

  it("gives back the header and the rows: multi-line quoted fields, delimiters, quotes, formulas", () => {
    const header = ["id", "=name", "'note"];
    const rows = [
      ["1", "two\r\nlines", 'a "quoted" word'],
      ["2", "=1+1", "'=already"],
      ["3", "", ""],
      ["4", "x,y;z|w\tv", "\n"],
      ["5", "-5", "''@"],
    ];
    for (const delimiter of [",", ";", "\t", "|"] as const) {
      const text = buildRejectsCsv({
        header,
        rejects: rows.map((row, i) => ({ line: i + 2, row, reasons: [reason("rejected")] })),
        delimiter,
      });
      const read = parse(text, delimiter);
      expect(isRejectsHeader(read[0])).toBe(true);
      expect(read.slice(1).every((row) => row.at(-1) === "rejected")).toBe(true);
      expect(restoreRejectsRows(read)).toEqual([header, ...rows]);
    }
  });

  it("gives back any rows (seeded)", () => {
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      const next = random(seed);
      const width = 1 + Math.floor(next() * 4);
      const header = Array.from({ length: width }, () => value(next));
      const rows = Array.from({ length: 1 + Math.floor(next() * 30) }, () =>
        Array.from({ length: width }, () => value(next)),
      );
      const delimiter = ([",", ";", "\t", "|"] as const)[seed % 4]!;
      const text = buildRejectsCsv({
        header,
        rejects: rows.map((row, i) => ({
          line: i + 2,
          row,
          reasons: [reason("not_null", value(next))],
        })),
        delimiter,
      });
      const read = parse(text, delimiter);
      expect(restoreRejectsRows(read), `seed ${seed}`).toEqual([header, ...rows]);
    }
  });
});
