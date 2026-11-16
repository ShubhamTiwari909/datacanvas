import type { EditableColumn, RowCell, TableEditInfo } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  buildDelete,
  buildInsert,
  buildUpdate,
  cellEditBlock,
  changedFields,
  checkValue,
  columnEditBlock,
  deleteBeforeAfter,
  initialInsertMode,
  insertBeforeAfter,
  insertModes,
  notEditableText,
  rowAddress,
  shownText,
  typeHint,
  updateBeforeAfter,
} from "./row-edit";

const users = { schema: "public", name: "users" };
const value = (v: string | null, truncated = false): RowCell => ({ value: v, truncated });

const col = (name: string, overrides: Partial<EditableColumn> = {}): EditableColumn => ({
  name,
  dataType: "text",
  nullable: true,
  hasDefault: false,
  generated: false,
  identity: null,
  editable: true,
  inKey: false,
  ...overrides,
});

const info: TableEditInfo = {
  table: users,
  editable: true,
  reason: null,
  key: ["id"],
  columns: [col("id", { dataType: "integer", nullable: false, inKey: true }), col("email")],
  triggers: [],
  rowSecurity: false,
  incomingForeignKeys: [],
};
const columns = [
  { name: "id", masked: false },
  { name: "email", masked: false },
];

describe("editability", () => {
  it("explains every reason a table cannot be edited", () => {
    for (const reason of [
      "not_a_table",
      "no_key",
      "foreign_table",
      "partition_of_other",
      "not_found",
      null,
    ] as const) {
      expect(notEditableText(reason)).toMatch(/\.$/);
    }
    expect(notEditableText("no_key")).toMatch(/primary key/);
  });

  it("blocks hidden, generated and bytea columns, and cut cells", () => {
    expect(columnEditBlock({ masked: false }, col("a"))).toBeNull();
    expect(columnEditBlock({ masked: true }, col("a"))).toMatch(/hidden/);
    expect(columnEditBlock({ masked: false }, col("a", { generated: true }))).toMatch(/database/);
    expect(columnEditBlock({ masked: false }, col("a", { editable: false }))).toMatch(/type/);
    expect(columnEditBlock({ masked: false }, undefined)).not.toBeNull();
    expect(cellEditBlock({ masked: false }, value("x", true), col("a"))).toMatch(/part/);
    expect(cellEditBlock({ masked: false }, value(null), col("a"))).toBeNull();
  });

  it("finds a row by its key cells", () => {
    expect(rowAddress(columns, [value("7"), value("a@x.test")], info)).toEqual({
      ok: true,
      key: [{ column: "id", value: "7" }],
    });
  });

  it("refuses a row whose key is missing, hidden, cut or NULL", () => {
    expect(rowAddress([columns[1]!], [value("a")], info).ok).toBe(false);
    expect(
      rowAddress([{ name: "id", masked: true }, columns[1]!], [value(""), value("a")], info),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/hidden/) });
    expect(rowAddress(columns, [value("7", true), value("a")], info).ok).toBe(false);
    expect(rowAddress(columns, [value(null), value("a")], info).ok).toBe(false);
    expect(
      rowAddress(columns, [value("7"), value("a")], { ...info, editable: false, reason: "no_key" }),
    ).toMatchObject({ ok: false, reason: notEditableText("no_key") });
  });
});

describe("building changes", () => {
  const key = [{ column: "id", value: "7" }];

  it("updates only what changed, with what was seen", () => {
    const fields = [
      { column: "email", original: "a@x.test", next: "b@x.test" },
      { column: "name", original: "Ann", next: "Ann" },
      { column: "note", original: "", next: null },
    ];
    expect(changedFields(fields).map((f) => f.column)).toEqual(["email", "note"]);
    expect(buildUpdate(users, key, fields)).toEqual({
      kind: "update_row",
      table: users,
      key,
      set: [
        { column: "email", value: "b@x.test" },
        { column: "note", value: null },
      ],
      expected: [
        { column: "email", value: "a@x.test" },
        { column: "note", value: "" },
      ],
    });
  });

  it("returns no update when nothing changed (NULL and empty are different)", () => {
    expect(buildUpdate(users, key, [{ column: "a", original: null, next: null }])).toBeNull();
    expect(buildUpdate(users, key, [{ column: "a", original: null, next: "" }])).not.toBeNull();
  });

  it("deletes by key", () => {
    expect(buildDelete(users, key)).toEqual({ kind: "delete_row", table: users, key });
  });

  it("inserts values and NULLs, and leaves defaults out", () => {
    expect(
      buildInsert(users, [
        { column: "id", mode: "default", value: "ignored" },
        { column: "email", mode: "value", value: "" },
        { column: "note", mode: "null", value: "ignored" },
      ]),
    ).toEqual({
      kind: "insert_row",
      table: users,
      values: [
        { column: "email", value: "" },
        { column: "note", value: null },
      ],
    });
  });

  it("starts each column of a new row sensibly", () => {
    expect(initialInsertMode(col("id", { identity: "always" }))).toBe("default");
    expect(initialInsertMode(col("a", { hasDefault: true, nullable: false }))).toBe("default");
    expect(initialInsertMode(col("a", { nullable: false }))).toBe("value");
    expect(initialInsertMode(col("a"))).toBe("default");
    expect(insertModes(col("g", { generated: true }))).toEqual(["default"]);
    expect(insertModes(col("n"))).toEqual(["default", "null", "value"]);
  });

  it("offers a required column without a default only a value (omitting it would fail)", () => {
    const required = col("a", { nullable: false });
    expect(insertModes(required)).toEqual(["value"]);
    expect(initialInsertMode(required)).toBe("value");
    expect(insertModes(col("a", { nullable: false, hasDefault: true }))).toEqual([
      "default",
      "value",
    ]);
    expect(insertModes(col("a", { nullable: false, identity: "by_default" }))).toEqual([
      "default",
      "value",
    ]);
  });

  it("offers a column of a type that cannot be edited only its default, never NULL", () => {
    for (const nullable of [true, false]) {
      const column = col("b", { editable: false, nullable });
      expect(insertModes(column)).toEqual(["default"]);
      // The start is a mode the form offers, so a radio is always selected.
      expect(initialInsertMode(column)).toBe("default");
    }
  });

  it("always starts on a mode the column offers", () => {
    for (const generated of [true, false])
      for (const editable of [true, false])
        for (const nullable of [true, false])
          for (const hasDefault of [true, false])
            for (const identity of [null, "always", "by_default"] as const) {
              const column = col("c", { generated, editable, nullable, hasDefault, identity });
              expect(insertModes(column)).toContain(initialInsertMode(column));
            }
  });
});

describe("before and after", () => {
  it("lists the changed columns of an update", () => {
    const rows = updateBeforeAfter([
      { column: "email", original: "a", next: "" },
      { column: "same", original: "x", next: "x" },
    ]);
    expect(rows).toEqual([
      {
        column: "email",
        before: { kind: "value", text: "a", cut: false },
        after: { kind: "value", text: "", cut: false },
      },
    ]);
    expect(rows.map((r) => [shownText(r.before), shownText(r.after)])).toEqual([["a", "(empty)"]]);
  });

  it("shows defaults and NULLs of an insert", () => {
    expect(
      insertBeforeAfter([
        { column: "id", mode: "default", value: "" },
        { column: "n", mode: "null", value: "" },
      ]).map((r) => shownText(r.after)),
    ).toEqual(["(default)", "NULL"]);
  });

  it("shows a deleted row without its hidden columns, marking cut values", () => {
    const rows = deleteBeforeAfter(
      [
        { name: "id", masked: false },
        { name: "token", masked: true },
        { name: "bio", masked: false },
      ],
      [value("7"), value(""), value("long", true)],
    );
    expect(rows.map((r) => [r.column, shownText(r.before), shownText(r.after)])).toEqual([
      ["id", "7", "(deleted)"],
      ["bio", "long…", "(deleted)"],
    ]);
  });
});

describe("value hints", () => {
  it("describes common types", () => {
    expect(typeHint("integer")).toMatch(/whole/);
    expect(typeHint("integer[]")).toMatch(/array/i);
    expect(typeHint("timestamp with time zone")).toMatch(/\+00/);
    expect(typeHint("timestamp without time zone")).not.toMatch(/\+00/);
    expect(typeHint("jsonb")).toMatch(/JSON/);
    expect(typeHint("text")).toBeNull();
  });

  it("checks obvious mistakes without repeating the value", () => {
    expect(checkValue("integer", "12")).toBeNull();
    expect(checkValue("integer", "1.5")).toMatch(/whole/);
    expect(checkValue("numeric(10,2)", "-1.5e3")).toBeNull();
    expect(checkValue("numeric", "abc")).toMatch(/number/);
    expect(checkValue("boolean", "yes")).toBeNull();
    expect(checkValue("boolean", "maybe")).not.toBeNull();
    expect(checkValue("jsonb", "{")).toMatch(/JSON/);
    expect(checkValue("jsonb", "secret-value")).not.toContain("secret-value");
    expect(checkValue("text", "anything")).toBeNull();
  });
});
