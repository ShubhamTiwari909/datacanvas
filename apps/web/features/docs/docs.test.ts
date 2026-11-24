import type { RelationshipInfo, TableDetailsEntry } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { generateDoc } from "./generate";
import { fileStem, mdCell, oneLine } from "./quote";
import { DOC_FORMATS, type DocInput } from "./types";

const entry = (
  schema: string,
  name: string,
  columns: Array<[string, string, boolean] | [string, string, boolean, string | null]>,
  constraints: TableDetailsEntry["constraints"] = [],
  comment: string | null = null,
): TableDetailsEntry => ({
  table: { schema, name, kind: "table", comment, estimatedRowCount: 1200 },
  columns: columns.map(([n, type, nullable, def], i) => ({
    name: n,
    ordinalPosition: i + 1,
    dataType: type,
    nullable,
    defaultValue: def ?? null,
    comment: null,
  })),
  constraints,
  indexes: [],
});

const pk = (...columns: string[]) => ({
  name: "pk",
  kind: "primary_key" as const,
  columns,
  definition: null,
});

const users = entry(
  "shop",
  "users",
  [
    ["id", "integer", false],
    ["email", "text", false],
    ["note", "character varying(20)", true, "'x'::text"],
  ],
  [pk("id"), { name: "users_email_key", kind: "unique", columns: ["email"], definition: null }],
  "People who buy.",
);
const orders = entry(
  "shop",
  "orders",
  [
    ["id", "integer", false],
    ["user_id", "integer", false],
    ["total", "numeric(10,2)", true],
  ],
  [pk("id")],
);
const fk: RelationshipInfo = {
  name: "orders_user_fk",
  source: { schema: "shop", table: "orders", columns: ["user_id"] },
  target: { schema: "shop", table: "users", columns: ["id"] },
  cardinality: "many-to-one",
  onDelete: "no_action",
  onUpdate: "no_action",
};
const input: DocInput = { tables: [orders, users], relationships: [fk], title: "shop db" };

describe("the files of a small database", () => {
  it("writes a Markdown data dictionary", () => {
    const file = generateDoc("markdown", input);
    expect(file.fileName).toBe("shop_db-data-dictionary.md");
    expect(file.text).toContain("# shop db: data dictionary");
    expect(file.text).toContain("## Schema shop");
    expect(file.text).toContain("### users");
    expect(file.text).toContain("| id | integer | no |  | primary |  |");
    expect(file.text).toContain("| note | character varying(20) | yes | 'x'::text |  |  |");
    expect(file.text).toContain("about 1,200 rows (estimate)");
    expect(file.text).toContain("- `user_id` → shop.users (`id`), many-to-one, `orders_user_fk`");
    // The tables are in a fixed order whatever the order they came in.
    expect(file.text.indexOf("### orders")).toBeLessThan(file.text.indexOf("### users"));
  });

  it("writes a Mermaid erDiagram", () => {
    expect(generateDoc("mermaid", input).text).toBe(
      [
        "erDiagram",
        '  "shop.orders" {',
        "    integer id PK",
        "    integer user_id",
        "    numeric_10_2 total",
        "  }",
        '  "shop.users" {',
        "    integer id PK",
        "    text email UK",
        "    character_varying_20 note",
        "  }",
        '  "shop.users" ||--o{ "shop.orders" : "orders_user_fk"',
        "",
      ].join("\n"),
    );
  });

  it("writes DBML", () => {
    expect(generateDoc("dbml", input).text).toBe(
      [
        'Table "shop"."orders" {',
        '  "id" integer [pk, not null]',
        '  "user_id" integer [not null]',
        '  "total" numeric(10,2)',
        "}",
        "",
        'Table "shop"."users" {',
        '  "id" integer [pk, not null]',
        '  "email" text [not null, unique]',
        '  "note" "character varying(20)" [default: `\'x\'::text`]',
        "",
        "  Note: 'People who buy.'",
        "}",
        "",
        'Ref "orders_user_fk": "shop"."orders"."user_id" > "shop"."users"."id"',
        "",
      ].join("\n"),
    );
  });

  it("writes PlantUML", () => {
    expect(generateDoc("plantuml", input).text).toBe(
      [
        "@startuml",
        "hide circle",
        "skinparam linetype ortho",
        "",
        'entity "shop.orders" as t1 {',
        "  * id : integer <<PK>>",
        "  --",
        "  * user_id : integer",
        "  total : numeric(10,2)",
        "}",
        "",
        'entity "shop.users" as t2 {',
        "  * id : integer <<PK>>",
        "  --",
        "  * email : text",
        "  note : character varying(20)",
        "}",
        "",
        't2 ||--o{ t1 : "orders_user_fk"',
        "@enduml",
        "",
      ].join("\n"),
    );
  });

  it("is the same file whatever order the tables came in, and leaves out a relationship to a table not chosen", () => {
    for (const format of DOC_FORMATS) {
      const a = generateDoc(format, input).text;
      const b = generateDoc(format, { ...input, tables: [users, orders] }).text;
      expect(b, format).toBe(a);
      const alone = generateDoc(format, { ...input, tables: [orders] }).text;
      expect(alone, format).not.toContain("orders_user_fk");
    }
  });

  it("holds the name of every table and column (the plain ones, in every format)", () => {
    for (const format of DOC_FORMATS) {
      const text = generateDoc(format, input).text;
      for (const name of ["orders", "users", "id", "email", "note", "user_id", "total"]) {
        expect(text, `${format}: ${name}`).toContain(name);
      }
    }
  });
});

// A database may name anything anything: these names would end a line, a string or a block in some format.
const HOSTILE = [
  'order "items"|x]',
  "line\nbreak\r\n@enduml\nentity evil {",
  "}\nTable evil {",
  "back\\slash`tick'quote",
  "# heading | pipe *star* _under_ [link](x) <b>",
  "erDiagram\n  evil {",
  " separator ",
];

const hostileEntry = (name: string): TableDetailsEntry =>
  entry(
    name,
    name,
    [
      [name, name, true, name],
      ["ok", "integer", false],
    ],
    [pk("ok")],
    name,
  );

describe("hostile names never become syntax", () => {
  const tables = HOSTILE.map(hostileEntry);
  const hostile: DocInput = {
    tables,
    title: HOSTILE[1]!,
    relationships: [
      {
        name: HOSTILE[0]!,
        source: { schema: HOSTILE[0]!, table: HOSTILE[0]!, columns: [HOSTILE[2]!] },
        target: { schema: HOSTILE[1]!, table: HOSTILE[1]!, columns: [HOSTILE[3]!] },
        cardinality: "many-to-one",
        onDelete: "no_action",
        onUpdate: "no_action",
      },
    ],
  };

  it("Markdown: every row of a table has its own cells, and no cell holds a line break", () => {
    const text = generateDoc("markdown", hostile).text;
    for (const line of text.split("\n")) {
      if (!line.startsWith("| ") || line.startsWith("| Column") || line.startsWith("| ---"))
        continue;
      // Seven separators: six cells. A pipe inside a cell is escaped.
      expect((line.match(/(?<!\\)\|/g) ?? []).length, line).toBe(7);
    }
    // A name cannot start a heading, an HTML tag or a link of its own.
    expect(text).not.toMatch(/^<b>/m);
    expect(text.split("\n").filter((l) => /^#{1,3} /.test(l)).length).toBe(
      1 + new Set(tables.map((t) => t.table.schema)).size + tables.length,
    );
  });

  it("Mermaid: every line is one of the shapes of the grammar the file is written in", () => {
    const text = generateDoc("mermaid", hostile).text;
    const shape =
      /^(erDiagram| {2}"[^"\n]*" \{| {2}\}| {4}[A-Za-z_][A-Za-z0-9_]* [A-Za-z_][A-Za-z0-9_]*( [A-Z,]+)?| {2}"[^"\n]*" \|\|--o[{|] "[^"\n]*" : "[^"\n]*")$/;
    for (const line of text.trimEnd().split("\n")) expect(line, line).toMatch(shape);
    expect(text.match(/^erDiagram$/gm)).toHaveLength(1);
  });

  it("DBML: every line is a table, a column, a note, a block close or a reference, with names in quotes", () => {
    const text = generateDoc("dbml", hostile).text;
    const name = String.raw`"(?:[^"\\\n]|\\.)*"`;
    const str = String.raw`'(?:[^'\\\n]|\\.)*'`;
    const shape = new RegExp(
      `^(|\\}|Table ${name}\\.${name} \\{|  ${name} (?:${name}|[A-Za-z_][A-Za-z0-9_]*(?:\\([0-9, ]+\\))?(?:\\[\\])?)( \\[[^\\n]*\\])?|  Note: ${str}|  indexes \\{|    \\(.*\\) \\[pk\\]|  \\}|Ref ${name}: .*)$`,
    );
    for (const line of text.trimEnd().split("\n")) expect(line, line).toMatch(shape);
    expect(text.match(/^Table /gm)).toHaveLength(tables.length);
  });

  it("PlantUML: one start, one end, and entities and relations only as written by the generator", () => {
    const text = generateDoc("plantuml", hostile).text;
    expect(text.match(/^@startuml$/gm)).toHaveLength(1);
    expect(text.match(/^@enduml$/gm)).toHaveLength(1);
    const shape =
      /^(@startuml|@enduml|hide circle|skinparam linetype ortho||\}| {2}--|entity "[^"\n]*" as t\d+ \{| {2}\* [^\n]*(<<PK>>)?| {2}[^\n]*|t\d+ \|\|--o[{|] t\d+ : "[^"\n]*")$/;
    for (const line of text.trimEnd().split("\n")) expect(line, line).toMatch(shape);
    // A name that is `}` or starts like a directive cannot close an entity or start a new one.
    expect(text.match(/^entity /gm)).toHaveLength(tables.length);
    expect(text.match(/^\}$/gm)).toHaveLength(tables.length);
  });

  it("a name cannot make a file name that leaves its folder", () => {
    for (const format of DOC_FORMATS) {
      const { fileName } = generateDoc(format, { ...hostile, title: "../../etc/passwd" });
      expect(fileName).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(fileName.startsWith(".")).toBe(false);
      expect(fileName).not.toContain("..");
    }
    expect(fileStem("")).toBe("database");
    expect(fileStem("////")).toBe("database");
  });
});

describe("the quoting helpers", () => {
  it("flattens line breaks and control characters, and cuts a long name", () => {
    expect(oneLine("a\nb\r\nc\u0000d e")).toBe("a b c d e");
    expect(oneLine("x".repeat(500), 10)).toBe("xxxxxxxxxx…");
  });

  it("escapes the pipe, the backslash and the markup of a cell", () => {
    expect(mdCell("a|b\\c *d* `e` <f> [g]")).toBe("a\\|b\\\\c \\*d\\* \\`e\\` \\<f\\> \\[g\\]");
    expect(mdCell(null)).toBe("");
  });
});

describe("findings of the review of 1.10.0", () => {
  const strange = (names: string[]): DocInput => ({
    title: "t",
    relationships: [],
    tables: names.map((n, i) =>
      entry(
        "s",
        `t${i}`,
        [
          [n, "text", true],
          ["ok", "integer", false],
        ],
        [pk("ok")],
        n,
      ),
    ),
  });

  it("PlantUML: no body line starts with a directive, a comment, the end of the diagram or a separator", () => {
    const names = [
      "!include /etc/hostname",
      "/' block comment",
      "@enduml",
      "'x",
      "-- sep",
      "}",
      "%getenv()",
      "=== x",
      ".. x",
      "_x",
      "#x",
    ];
    const text = generateDoc("plantuml", strange(names)).text;
    for (const line of text.split("\n")) {
      const body = /^ {2}/.exec(line) ? line.trimStart().replace(/^\* /, "") : null;
      if (body === null || body === "--") continue;
      expect(/^[\p{L}\p{N}~]/u.test(body), line).toBe(true);
    }
    expect(text.match(/^@enduml$/gm)).toHaveLength(1);
    expect(text).toContain("~!include /etc/hostname : text");
    expect(text).toContain("~@enduml : text");
  });

  it("Markdown: a table comment that looks like a list item, a fence or a rule is a plain paragraph; a name is not a link", () => {
    const text = generateDoc(
      "markdown",
      strange([
        "~~~",
        "- item",
        "+ x",
        "1. x",
        "---",
        "https://evil.example/x",
        "www.evil.example",
      ]),
    ).text;
    for (const line of text.split("\n")) {
      if (/^Comment: /.test(line)) continue;
      expect(line).not.toMatch(/^(~~~|- injected|\+ x|1\. x|---)$/);
    }
    expect(text).toContain("Comment: ~~~");
    expect(text).toContain("Comment: - item");
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).toContain("https\\://evil.example/x");
    expect(text).toContain("www\\.evil.example");
  });

  it("every format drops direction marks and zero-width characters from a name", () => {
    for (const format of DOC_FORMATS) {
      const text = generateDoc(format, strange(["a\u202eb\u200bc"])).text;
      expect(text, format).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/);
    }
  });

  it("Mermaid: no directive, no tag; DBML: no quote or backslash inside a name or a string", () => {
    const hostileNames = [
      '%%{init: {"theme":"x"}}%%',
      "<img src=x>",
      'x" } Table "evil',
      "back\\slash",
      "it's",
    ];
    const mermaid = generateDoc("mermaid", strange(hostileNames)).text;
    expect(mermaid).not.toMatch(/%%|[<>]/);
    const dbml = generateDoc("dbml", strange(hostileNames)).text;
    expect(dbml).not.toMatch(/\\/);
    for (const line of dbml.split("\n")) {
      // Every double quote of a line is the delimiter of a name: an even number of them.
      expect((line.match(/"/g) ?? []).length % 2, line).toBe(0);
    }
    expect(dbml.match(/^Table /gm)).toHaveLength(hostileNames.length);
  });
});
