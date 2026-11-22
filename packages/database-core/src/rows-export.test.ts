import { describe, expect, it } from "vitest";
import {
  EXPORT_MAX_BYTES,
  EXPORT_MAX_ROWS,
  createFormatter,
  defuse,
  uniqueKeys,
  type FormatOptions,
} from "./rows-export.js";

const source = {
  table: { schema: "public", name: "t" },
  at: new Date("2026-11-21T10:00:00.000Z"),
  filters: ["status equals"],
};
const options = (over: Partial<FormatOptions> = {}): FormatOptions => ({
  format: "csv",
  delimiter: ",",
  header: true,
  nullText: "",
  meta: false,
  ...over,
});
const columns = [
  { name: "id", dataType: "integer" },
  { name: "note", dataType: "text" },
];
const run = (
  o: FormatOptions,
  batches: Array<Array<Array<string | null>>>,
  info: { cut?: "rows" | "bytes" | null; cellsCut?: number; leftOut?: string[] } = {},
): string => {
  const f = createFormatter(o, source);
  const leftOut = info.leftOut ?? [];
  let out = f.start(columns, leftOut);
  let rows = 0;
  for (const b of batches) {
    out += f.rows(b);
    rows += b.length;
  }
  return out + f.end({ rows, cut: info.cut ?? null, cellsCut: info.cellsCut ?? 0, leftOut });
};

describe("defuse", () => {
  it("puts an apostrophe before what a spreadsheet would run, and leaves numbers and text alone", () => {
    for (const v of ["=1+1", "+cmd", "-x", "@sum", "|calc", "\t=x", " =1", "\u0001=1"]) {
      expect(defuse(v), v).toBe(`'${v}`);
    }
    for (const v of ["-5", "-1.5e3", "42", "plain", "a=b", "", "'=quoted"]) {
      expect(defuse(v), v).toBe(v);
    }
  });
});

describe("CSV and TSV", () => {
  it("writes a header, quotes what needs it, keeps NULL apart from the empty string only when told", () => {
    const text = run(options(), [
      [
        ["1", 'say "hi", ok'],
        ["2", null],
        ["3", ""],
        ["4", "a\nb"],
      ],
    ]);
    expect(text).toBe('id,note\r\n1,"say ""hi"", ok"\r\n2,\r\n3,\r\n4,"a\nb"\r\n');
    const marked = run(options({ nullText: "NULL" }), [
      [
        ["2", null],
        ["3", ""],
      ],
    ]);
    expect(marked).toBe("id,note\r\n2,NULL\r\n3,\r\n");
  });

  it("defuses a formula but not the word the person chose for NULL", () => {
    expect(run(options(), [[["1", "=HYPERLINK(1)"]]])).toContain("1,'=HYPERLINK(1)");
    expect(run(options({ nullText: "-" }), [[["1", null]]])).toContain("1,-\r\n");
  });

  it("uses a semicolon or a tab, and can leave the header out", () => {
    expect(run(options({ delimiter: ";", header: false }), [[["1", "a;b"]]])).toBe('1;"a;b"\r\n');
    expect(run(options({ format: "tsv" }), [[["1", "a\tb"]]])).toBe('id\tnote\r\n1\t"a\tb"\r\n');
  });

  it("is the same text when the rows come in several batches", () => {
    const rows: Array<Array<string | null>> = [
      ["1", "a"],
      ["2", "b"],
      ["3", "c"],
    ];
    expect(run(options(), [rows])).toBe(run(options(), [[rows[0]!], [rows[1]!, rows[2]!], []]));
  });

  it("says at the end that it was cut, always, and adds notes when asked", () => {
    expect(run(options(), [[["1", "a"]]])).not.toContain("#");
    const cut = run(options(), [[["1", "a"]]], { cut: "rows" });
    expect(cut).toContain(
      `# This file was cut at the limit of ${EXPORT_MAX_ROWS.toLocaleString("en-US")} rows.`,
    );
    const bytes = run(options(), [[["1", "a"]]], { cut: "bytes" });
    expect(bytes).toContain(`${EXPORT_MAX_BYTES / (1024 * 1024)} MB`);
    const notes = run(options({ meta: true }), [[["1", "a"]]], {
      leftOut: ["password"],
      cellsCut: 2,
    });
    expect(notes).toContain("# Exported from public.t at 2026-11-21T10:00:00.000Z.");
    expect(notes).toContain("# 1 row.");
    expect(notes).toContain("# Filtered by: status equals.");
    expect(notes).toContain("# Left out because they look sensitive: password.");
    expect(notes).toContain("2 values were longer than");
  });
});

describe("JSON and NDJSON", () => {
  it("writes JSON as an object with the rows and the notes, valid however the rows are batched", () => {
    const rows: Array<Array<string | null>> = [
      ["1", "a"],
      ["2", null],
      ["3", 'q"uote'],
    ];
    for (const batches of [[rows], [[rows[0]!], [], [rows[1]!, rows[2]!]]]) {
      const parsed = JSON.parse(run(options({ format: "json" }), batches));
      expect(parsed.rows).toEqual([
        { id: "1", note: "a" },
        { id: "2", note: null },
        { id: "3", note: 'q"uote' },
      ]);
      expect(parsed._meta).toMatchObject({
        source: "public.t",
        rows: 3,
        cut: null,
        filters: ["status equals"],
      });
    }
    // An empty table is still valid JSON.
    expect(JSON.parse(run(options({ format: "json" }), [])).rows).toEqual([]);
  });

  it("says in the notes when it was cut and what was left out", () => {
    const parsed = JSON.parse(
      run(options({ format: "json" }), [[["1", "a"]]], {
        cut: "rows",
        leftOut: ["token"],
        cellsCut: 1,
      }),
    );
    expect(parsed._meta).toMatchObject({ cut: "rows", columnsLeftOut: ["token"], valuesCut: 1 });
  });

  it("keeps a large number and a leading zero as the text they were", () => {
    const text = run(options({ format: "json" }), [[["12345678901234567890", "007"]]]);
    expect(text).toContain('"id":"12345678901234567890"');
    expect(text).toContain('"note":"007"');
  });

  it("writes NDJSON as one object per line, with a last line of notes only when asked or cut", () => {
    const rows: Array<Array<string | null>> = [
      ["1", "a"],
      ["2", null],
    ];
    const plain = run(options({ format: "ndjson" }), [rows]);
    expect(
      plain
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual([
      { id: "1", note: "a" },
      { id: "2", note: null },
    ]);
    const cut = run(options({ format: "ndjson" }), [rows], { cut: "bytes" })
      .trim()
      .split("\n");
    expect(cut).toHaveLength(3);
    expect(JSON.parse(cut[2]!)._meta.cut).toBe("bytes");
  });

  it("gives a repeated column name a key of its own", () => {
    expect(uniqueKeys(["a", "a", "a (2)", "b"])).toEqual(["a", "a (2)", "a (2) (2)", "b"]);
  });
});

describe("what the review of 1.8.0 found in the formatters", () => {
  it("cuts every name in the notes to one line, so a name cannot start a line of its own", () => {
    const hostile = createFormatter(options({ meta: true }), {
      table: { schema: "public", name: 'a\n=HYPERLINK("http://evil","x")' },
      at: new Date("2026-11-21T10:00:00.000Z"),
      filters: ["col\r\n=cmd|' /C calc'!A0 equals"],
    });
    hostile.start(columns, []);
    const text = hostile.end({ rows: 1, cut: null, cellsCut: 0, leftOut: ["tok\n=1+1\u2028x"] });
    // Every physical line of the notes is a `# ` line.
    for (const line of text.split("\r\n").filter((l) => l !== ""))
      expect(line.startsWith("# ")).toBe(true);
    expect(text).not.toMatch(/\n=/);
  });

  it("quotes the empty value when there is only one column, so it is not a blank line", () => {
    const f = createFormatter(options({ header: false }), source);
    f.start([{ name: "a", dataType: "text" }], []);
    const text = f.rows([["x"], [""], [null], ["y"]]);
    expect(text).toBe('x\r\n""\r\n""\r\ny\r\n');
    expect(text.split("\r\n").filter((l) => l === "")).toHaveLength(1);
    // With several columns an empty field is still empty.
    const wide = createFormatter(options({ header: false }), source);
    wide.start(columns, []);
    expect(wide.rows([["1", ""]])).toBe("1,\r\n");
  });

  it("gives a column called _meta a key of its own in NDJSON, so a row is never the line of notes", () => {
    const f = createFormatter(options({ format: "ndjson" }), source);
    f.start([{ name: "_meta", dataType: "text" }], []);
    const line = f.rows([["hello"]]);
    expect(JSON.parse(line)).toEqual({ "_meta (2)": "hello" });
    expect(uniqueKeys(["a", "_meta"], ["_meta"])).toEqual(["a", "_meta (2)"]);
  });
});
