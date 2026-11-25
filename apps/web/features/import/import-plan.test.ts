import { IMPORT_MAX_ROWS, type TableEditInfo } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  buildChange,
  buildImport,
  dataRowsOf,
  fileRowNumber,
  importableColumns,
  mappableColumns,
  mappingProblem,
  missingRequired,
  previewRows,
  readField,
  suggestMapping,
  validateRequestForImport,
} from "./import-plan";

const column = (name: string, over: Partial<TableEditInfo["columns"][number]> = {}) => ({
  name,
  dataType: "text",
  nullable: true,
  hasDefault: false,
  generated: false,
  identity: null,
  editable: true,
  inKey: false,
  ...over,
});
const info = {
  table: { schema: "public", name: "people" },
  editable: true,
  reason: null,
  key: ["id"],
  columns: [
    column("id", {
      dataType: "integer",
      nullable: false,
      hasDefault: true,
      identity: "by_default",
      inKey: true,
    }),
    column("full_name", { nullable: false }),
    column("Email Address"),
    column("total", { generated: true, editable: false }),
    column("blob", { editable: false }),
  ],
  triggers: [],
  rowSecurity: false,
  incomingForeignKeys: [],
} as unknown as TableEditInfo;

const table = { schema: "public", name: "people" };
const rule = { emptyIsNull: true, words: [] as string[] };

describe("readField", () => {
  it("reads an empty field as NULL or as the empty string, as the person chose", () => {
    expect(readField("", { emptyIsNull: true, words: [] })).toBeNull();
    expect(readField("", { emptyIsNull: false, words: [] })).toBe("");
  });

  it("reads the words the person named as NULL, exactly, and nothing else", () => {
    const r = { emptyIsNull: false, words: ["NULL", "\\N", "n/a"] };
    expect(readField("NULL", r)).toBeNull();
    expect(readField("\\N", r)).toBeNull();
    expect(readField("n/a", r)).toBeNull();
    // Another case, a space, or part of a word is a value.
    expect(readField("null", r)).toBe("null");
    expect(readField("NULL ", r)).toBe("NULL ");
    expect(readField("N/A", r)).toBe("N/A");
    expect(readField("  ", r)).toBe("  ");
    expect(readField("0", r)).toBe("0");
  });
});

describe("the columns of the table", () => {
  it("offers only the columns a person can give a value to", () => {
    expect(importableColumns(info).map((c) => c.name)).toEqual([
      "id",
      "full_name",
      "Email Address",
    ]);
  });

  it("suggests a column by name, then without case, spaces and underscores, each column once", () => {
    expect(suggestMapping(["id", "Full Name", "email_address", "extra"], info)).toEqual([
      "id",
      "full_name",
      "Email Address",
      null,
    ]);
    expect(suggestMapping(["full_name", "FULL_NAME"], info)).toEqual(["full_name", null]);
    // A column that cannot be given a value is never suggested, whatever the file calls it.
    expect(suggestMapping(["total", "blob"], info)).toEqual([null, null]);
  });

  it("names the columns the table needs and the file does not give (NOT NULL, no default, not filled by the database)", () => {
    expect(missingRequired(info, ["id", null, "Email Address"])).toEqual(["full_name"]);
    expect(missingRequired(info, [null, "full_name", null])).toEqual([]);
  });
});

describe("suggestMapping, with names that differ only loosely", () => {
  it("gives an exact name its column even when a looser header comes first", () => {
    const two = {
      ...info,
      columns: [...info.columns, column("fullName")],
    };
    expect(suggestMapping(["full_name", "fullName"], two)).toEqual(["full_name", "fullName"]);
    expect(suggestMapping(["fullName", "full_name"], two)).toEqual(["fullName", "full_name"]);
  });

  it("suggests nothing for a header that is empty, even for a column whose loose name is empty", () => {
    const odd = { ...info, columns: [...info.columns, column("_")] };
    expect(suggestMapping(["", ""], odd)).toEqual([null, null]);
  });
});

describe("mappingProblem", () => {
  it("names a required column that an import cannot give a value to", () => {
    const withBlob = {
      ...info,
      columns: [
        ...info.columns,
        column("blob", { dataType: "bytea", nullable: false, editable: false }),
      ],
    };
    expect(mappingProblem(withBlob, ["full_name"], 3)).toMatch(
      /blob needs a value .* cannot be given one by an import/,
    );
  });

  it("is null when the choices can be imported", () => {
    expect(mappingProblem(info, ["full_name", "Email Address"], 3)).toBeNull();
  });

  it("says why not: nothing chosen, a column twice, a column that cannot be given, a missing required column, no rows, too many", () => {
    expect(mappingProblem(info, [null, null], 3)).toMatch(/at least one/);
    expect(mappingProblem(info, ["full_name", "full_name"], 3)).toMatch(/same column/);
    expect(mappingProblem(info, ["total"], 3)).toMatch(/cannot be given a value/);
    expect(mappingProblem(info, ["Email Address"], 3)).toMatch(/full_name needs a value/);
    expect(mappingProblem(info, ["full_name"], 0)).toMatch(/no rows/);
    expect(mappingProblem(info, ["full_name"], IMPORT_MAX_ROWS + 1)).toMatch(/Too many rows/);
  });
});

describe("buildImport", () => {
  const rows = [
    ["Name", "Mail", "skip"],
    ["Ann", "a@x.test", "1"],
    ["Bo", "", "2"],
    ["NULL", "c@x.test", "3"],
  ];

  it("carries the table's own column names, only the chosen columns, and every row read by the rule", () => {
    const change = buildImport(table, {
      rows,
      header: true,
      mapping: ["full_name", "Email Address", null],
      rule: { emptyIsNull: true, words: ["NULL"] },
    });
    expect(change).toEqual({
      kind: "insert_rows",
      table,
      columns: ["full_name", "Email Address"],
      rows: [
        ["Ann", "a@x.test"],
        ["Bo", null],
        [null, "c@x.test"],
      ],
    });
  });

  it("never uses a name of the file: a header that looks like SQL is not in the change", () => {
    const change = buildImport(table, {
      rows: [
        ['x"; DROP TABLE people; --', "b"],
        ["1", "2"],
      ],
      header: true,
      mapping: ["full_name", null],
      rule,
    });
    expect(JSON.stringify(change)).not.toContain("DROP");
    expect(change.columns).toEqual(["full_name"]);
  });

  it("takes the first row as data when there is no header, and the empty string when asked", () => {
    expect(dataRowsOf({ rows, header: false })).toHaveLength(4);
    const change = buildImport(table, {
      rows: [["Ann", ""]],
      header: false,
      mapping: ["full_name", "Email Address"],
      rule: { emptyIsNull: false, words: [] },
    });
    expect(change.rows).toEqual([["Ann", ""]]);
  });

  it("previews the first rows as they will be read, and does not read the rest", () => {
    const many = [["h"], ...Array.from({ length: 50 }, (_, i) => [String(i)])];
    const preview = previewRows({ rows: many, header: true, mapping: ["full_name"], rule }, 10);
    expect(preview.columns).toEqual(["full_name"]);
    expect(preview.rows).toHaveLength(10);
    expect(preview.rows[0]).toEqual(["0"]);
  });

  it("counts a row of the file with the header as row 1", () => {
    expect(fileRowNumber(1, true)).toBe(2);
    expect(fileRowNumber(3, false)).toBe(3);
  });
});

describe("an import by key (4.1 and 4.2 of the write-side plan)", () => {
  // A table whose key is a column the database fills (GENERATED ALWAYS), and a unique code.
  const keyed = {
    ...info,
    columns: [
      column("id", {
        dataType: "integer",
        nullable: false,
        generated: true,
        identity: "always",
        inKey: true,
      }),
      column("code", { nullable: false }),
      column("full_name", { nullable: false }),
      column("note"),
    ],
    uniqueKeys: [
      { name: "people_pkey", columns: ["id"] },
      { name: "people_code_key", columns: ["code"] },
    ],
  } as unknown as TableEditInfo;
  const rows = [
    ["Code", "Name", "Note"],
    ["A1", "Ann", ""],
    ["B2", "NULL", "x"],
  ];
  const input = {
    rows,
    header: true,
    mapping: ["code", "full_name", "note"],
    rule: { emptyIsNull: true, words: ["NULL"] },
  };

  it("lets the key of an update only be a column the database fills, and only then", () => {
    expect(mappableColumns(keyed).map((c) => c.name)).toEqual(["code", "full_name", "note"]);
    expect(mappableColumns(keyed, { mode: "upsert", key: ["id"] }).map((c) => c.name)).toEqual([
      "code",
      "full_name",
      "note",
    ]);
    expect(mappableColumns(keyed, { mode: "update", key: ["id"] }).map((c) => c.name)).toEqual([
      "id",
      "code",
      "full_name",
      "note",
    ]);
    expect(suggestMapping(["id", "note"], keyed, { mode: "update", key: ["id"] })).toEqual([
      "id",
      "note",
    ]);
    expect(suggestMapping(["id", "note"], keyed)).toEqual([null, "note"]);
  });

  it("names the columns of the key that are not mapped, and needs a column that is not the key for an update", () => {
    const update = { mode: "update", key: ["id"] } as const;
    expect(mappingProblem(keyed, ["note"], 2, update)).toBe(
      "id is part of the key and is not mapped: choose a column of the file for it.",
    );
    expect(mappingProblem(keyed, ["note"], 2, { mode: "upsert", key: ["code", "full_name"] })).toBe(
      "code, full_name are part of the key and are not mapped: choose columns of the file for them.",
    );
    expect(mappingProblem(keyed, ["id"], 2, update)).toMatch(
      /at least one column that is not the key/,
    );
    // An update only never adds a row: the columns a new row needs are not asked for.
    expect(mappingProblem(keyed, ["id", "note"], 2, update)).toBeNull();
    // An update or insert adds rows: they are.
    expect(mappingProblem(keyed, ["code", "note"], 2, { mode: "upsert", key: ["code"] })).toMatch(
      /full_name needs a value/,
    );
    expect(
      mappingProblem(keyed, ["code", "full_name"], 2, { mode: "upsert", key: ["code"] }),
    ).toBeNull();
    // A column the database fills is not mappable outside an update by that key.
    expect(mappingProblem(keyed, ["id", "note"], 2, { mode: "update", key: ["code"] })).toMatch(
      /cannot be given a value/,
    );
  });

  it("builds an insert, an update or insert, or an update only from the same rows, read the same way", () => {
    const insert = buildChange(table, input);
    expect(insert).toEqual(buildImport(table, input));
    const upsert = buildChange(table, input, {
      mode: "upsert",
      key: ["code"],
      updateColumns: ["note"],
    });
    expect(upsert).toEqual({
      kind: "upsert_rows",
      table,
      key: ["code"],
      columns: ["code", "full_name", "note"],
      rows: [
        ["A1", "Ann", null],
        ["B2", null, "x"],
      ],
      updateColumns: ["note"],
    });
    expect(
      buildChange(table, input, { mode: "upsert", key: ["code"], updateColumns: [] }),
    ).toMatchObject({ kind: "upsert_rows", updateColumns: [] });
    expect(
      buildChange(table, input, { mode: "update", key: ["code"], updateColumns: ["note"] }),
    ).toEqual({
      kind: "update_by_key",
      table,
      key: ["code"],
      columns: ["code", "full_name", "note"],
      rows: insert.rows,
    });
  });

  it("builds the change of the rows that remain once rows are left out", () => {
    const remaining = { ...input, rows: [rows[0]!, rows[2]!] };
    const change = buildChange(table, remaining, {
      mode: "upsert",
      key: ["code"],
      updateColumns: [],
    });
    expect(change.rows).toEqual([["B2", null, "x"]]);
  });

  it("validates an update or insert as an insert naming its key, and offers no validation for an update only", () => {
    const upsert = buildChange(table, input, {
      mode: "upsert",
      key: ["code"],
      updateColumns: ["note"],
    });
    expect(validateRequestForImport(upsert)).toEqual({
      schema: "public",
      table: "people",
      mode: "insert",
      columns: ["code", "full_name", "note"],
      rows: upsert.rows,
      upsertKey: ["code"],
    });
    const insert = validateRequestForImport(buildChange(table, input));
    expect(insert).not.toHaveProperty("upsertKey");
    expect(insert).toMatchObject({ mode: "insert" });
    expect(
      validateRequestForImport(
        buildChange(table, input, { mode: "update", key: ["code"], updateColumns: [] }),
      ),
    ).toBeNull();
  });
});
