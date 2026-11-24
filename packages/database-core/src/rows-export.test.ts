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

  it("defuses a formula, in a value or in the word chosen for NULL, but leaves a lone dash", () => {
    expect(run(options(), [[["1", "=HYPERLINK(1)"]]])).toContain("1,'=HYPERLINK(1)");
    expect(run(options({ nullText: "-" }), [[["1", null]]])).toContain("1,-\r\n");
    expect(run(options({ nullText: "=1+1" }), [[["1", null]]])).toContain("1,'=1+1\r\n");
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

describe("the INSERT script (decision 167)", () => {
  const source = {
    table: { schema: "public", name: "people" },
    at: new Date("2026-11-24T00:00:00Z"),
    filters: [],
  };
  const make = (cols: Array<{ name: string; generated?: boolean; identityAlways?: boolean }>) => {
    const formatter = createFormatter(
      { format: "sql", delimiter: ",", header: true, nullText: "", meta: false },
      source,
    );
    return {
      formatter,
      start: (leftOut: string[] = []) =>
        formatter.start(
          cols.map((c) => ({ dataType: "text", ...c })),
          leftOut,
        ),
    };
  };
  const whole = { rows: 2, cut: null, cellsCut: 0, leftOut: [] as string[] };

  it("is a transaction of INSERT statements with every value a quoted text literal or NULL, and commits only when whole", () => {
    const { formatter, start } = make([{ name: "id" }, { name: "name" }]);
    const text =
      start() +
      formatter.rows([
        ["1", "O'Brien"],
        ["2", null],
      ]) +
      formatter.end(whole);
    expect(text).toBe(
      [
        "-- DataCanvas export of public.people at 2026-11-24T00:00:00.000Z.",
        "-- Run it in an empty copy of the table: it inserts, it does not replace.",
        "BEGIN;",
        "SET LOCAL standard_conforming_strings = on;",
        "SET LOCAL datestyle = 'ISO, MDY';",
        "SET LOCAL intervalstyle = 'postgres';",
        'INSERT INTO "public"."people" ("id", "name") VALUES',
        "  ('1', 'O''Brien'),",
        "  ('2', NULL);",
        "-- 2 rows.",
        "COMMIT;",
        "",
      ].join("\n"),
    );
  });

  it("writes one statement for each 100 rows", () => {
    const { formatter, start } = make([{ name: "n" }]);
    start();
    const text = formatter.rows(Array.from({ length: 250 }, (_, i) => [String(i)]));
    expect(text.match(/^INSERT INTO /gm)).toHaveLength(3);
  });

  it("leaves out generated columns, keeps identity-always ones with OVERRIDING SYSTEM VALUE, and says both", () => {
    const { formatter, start } = make([
      { name: "id", identityAlways: true },
      { name: "total", generated: true },
      { name: "v" },
    ]);
    const text = start() + formatter.rows([["1", "9", "a"]]) + formatter.end({ ...whole, rows: 1 });
    expect(text).toContain("-- Left out because they are generated by the database: total.");
    expect(text).toContain(
      'INSERT INTO "public"."people" ("id", "v") OVERRIDING SYSTEM VALUE VALUES',
    );
    expect(text).toContain("('1', 'a');");
    expect(text).toContain("-- Identity sequences are not moved by this script");
  });

  it("writes DEFAULT VALUES for each row when no column is left to insert", () => {
    const { formatter, start } = make([{ name: "total", generated: true }]);
    start();
    expect(formatter.rows([["1"], ["2"]])).toBe(
      'INSERT INTO "public"."people" DEFAULT VALUES;\nINSERT INTO "public"."people" DEFAULT VALUES;\n',
    );
  });

  it("rolls itself back when it was cut, by a limit or a value over the cell limit: no COMMIT anywhere", () => {
    for (const cutInfo of [
      { ...whole, cut: "rows" as const },
      { ...whole, cut: "bytes" as const },
      { ...whole, cellsCut: 3 },
    ]) {
      const { formatter, start } = make([{ name: "id" }]);
      const text = start() + formatter.rows([["1"]]) + formatter.end(cutInfo);
      expect(text).toContain("-- INCOMPLETE: this script was cut");
      expect(text.trimEnd().endsWith("ROLLBACK;")).toBe(true);
      expect(text).not.toContain("COMMIT;");
    }
  });

  it("does not commit when columns were left out because their names look sensitive: it is not a copy of the table", () => {
    const { formatter, start } = make([{ name: "id" }]);
    const text =
      start(["password"]) +
      formatter.rows([["1"]]) +
      formatter.end({ ...whole, leftOut: ["password"] });
    expect(text).toContain(
      "-- INCOMPLETE: columns were left out because their names look sensitive",
    );
    expect(text.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    expect(text).not.toContain("COMMIT;");
  });

  it("sets what the text of its values depends on for the transaction only (SET LOCAL after BEGIN), never for the session", () => {
    const { start } = make([{ name: "id" }]);
    const text = start();
    expect(text.indexOf("BEGIN;")).toBeLessThan(
      text.indexOf("SET LOCAL standard_conforming_strings"),
    );
    expect(text).not.toMatch(/^SET (?!LOCAL)/m);
  });

  it("flattens every name in a comment, so a name with a line break cannot become a statement", () => {
    const hostile = "x\nDROP TABLE victim;\r-- more";
    const formatter = createFormatter(
      { format: "sql", delimiter: ",", header: true, nullText: "", meta: false },
      { table: { schema: hostile, name: hostile }, at: source.at, filters: [hostile] },
    );
    const text =
      formatter.start(
        [
          { name: hostile, dataType: "text", generated: true },
          { name: "ok", dataType: "text" },
        ],
        [hostile],
      ) + formatter.end(whole);
    for (const line of text.split("\n")) {
      expect(/^(--|SET |BEGIN;|COMMIT;|INSERT )/.test(line) || line === "", line).toBe(true);
    }
    // In the statements the name is an identifier in quotes, and a quote in it is doubled.
    expect(
      createFormatter(
        { format: "sql", delimiter: ",", header: true, nullText: "", meta: false },
        { table: { schema: 's"s', name: 't"t' }, at: source.at, filters: [] },
      ).rows([]),
    ).toBe("");
  });

  it("doubles a quote in a value, leaves a backslash alone (standard_conforming_strings is on), and keeps a line break in the literal", () => {
    const { formatter, start } = make([{ name: "v" }]);
    start();
    expect(formatter.rows([["it's \\ a\nb ; -- c"]])).toBe(
      'INSERT INTO "public"."people" ("v") VALUES\n  (\'it\'\'s \\ a\nb ; -- c\');\n',
    );
  });
});
