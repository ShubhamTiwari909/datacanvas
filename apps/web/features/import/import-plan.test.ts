import { IMPORT_MAX_ROWS, type TableEditInfo } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  buildImport,
  dataRowsOf,
  fileRowNumber,
  importableColumns,
  mappingProblem,
  missingRequired,
  previewRows,
  readField,
  suggestMapping,
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
