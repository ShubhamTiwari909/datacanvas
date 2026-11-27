import type { EditableColumn, RowFilter, TableEditInfo } from "@datacanvas/database-core";
import { changeSchema } from "@datacanvas/shared-types";
import { describe, expect, it } from "vitest";
import {
  buildDeleteMatching,
  buildUpdateMatching,
  canApplyPreview,
  matchingSetChoices,
  offersMatching,
  parseTypedCount,
  rowsText,
  typeCountLabel,
  typedCountMatches,
} from "./matching";
import { CHANGE_LABEL } from "./structure";

const col = (name: string, extra: Partial<EditableColumn> = {}): EditableColumn => ({
  name,
  dataType: "text",
  nullable: true,
  hasDefault: false,
  generated: false,
  identity: null,
  editable: true,
  inKey: false,
  ...extra,
});

const info = (columns: EditableColumn[], editable = true): TableEditInfo => ({
  table: { schema: "public", name: "t" },
  editable,
  reason: null,
  key: ["id"],
  columns,
  triggers: [],
  rowSecurity: false,
  incomingForeignKeys: [],
});

const filter: RowFilter = { column: "status", op: "eq", value: "new" };

describe("the count typed to confirm", () => {
  it("reads digits with or without thousands separators", () => {
    expect(parseTypedCount("1234")).toBe(1234);
    expect(parseTypedCount("1,234")).toBe(1234);
    expect(parseTypedCount(" 100,000 ")).toBe(100_000);
    expect(parseTypedCount("0")).toBe(0);
    expect(parseTypedCount("007")).toBe(7);
  });

  it("is not a count when it is empty, signed, decimal or grouped wrongly", () => {
    for (const text of [
      "",
      "  ",
      "-3",
      "+3",
      "3.0",
      "1e3",
      "12,34",
      "1,2345",
      ",123",
      "1 234",
      "x",
    ]) {
      expect(parseTypedCount(text), text).toBeNull();
    }
  });

  it("matches the preview's count as a number", () => {
    expect(typedCountMatches("1,234", 1234)).toBe(true);
    expect(typedCountMatches("1234", 1234)).toBe(true);
    expect(typedCountMatches("1233", 1234)).toBe(false);
    expect(typedCountMatches("", 1234)).toBe(false);
    // Any other change has no count to type.
    expect(typedCountMatches("", null)).toBe(true);
  });

  it("says the count with separators", () => {
    expect(rowsText(1)).toBe("1 row");
    expect(rowsText(12345)).toBe("12,345 rows");
    expect(typeCountLabel(12345)).toBe("Type 12,345 to confirm");
  });
});

describe("Apply", () => {
  const base = { ready: true, destructive: true, read: true, confirmRows: 3, typed: "3" };

  it("needs the tick and the right count", () => {
    expect(canApplyPreview(base)).toBe(true);
    expect(canApplyPreview({ ...base, read: false })).toBe(false);
    expect(canApplyPreview({ ...base, typed: "" })).toBe(false);
    expect(canApplyPreview({ ...base, typed: "4" })).toBe(false);
    expect(canApplyPreview({ ...base, ready: false })).toBe(false);
  });

  it("keeps the rules of the other changes", () => {
    const other = { ready: true, confirmRows: null, typed: "" };
    expect(canApplyPreview({ ...other, destructive: false, read: false })).toBe(true);
    expect(canApplyPreview({ ...other, destructive: true, read: false })).toBe(false);
    expect(canApplyPreview({ ...other, destructive: true, read: true })).toBe(true);
  });
});

describe("the buttons", () => {
  it("are offered only with a condition, on a table that can be edited", () => {
    expect(offersMatching([filter], info([]))).toBe(true);
    expect(offersMatching([], info([]))).toBe(false);
    expect(offersMatching([filter], info([], false))).toBe(false);
    expect(offersMatching([filter], null)).toBe(false);
  });

  it("use the history's labels", () => {
    expect(CHANGE_LABEL.update_matching).toBe("Set a value on all matching rows");
    expect(CHANGE_LABEL.delete_matching).toBe("Delete all matching rows");
  });
});

describe("the columns a value can be set on", () => {
  it("leave out the key, the columns the database fills, binary data and hidden columns", () => {
    const columns = [
      col("id", { inKey: true }),
      col("status"),
      col("total", { generated: true }),
      col("serial", { identity: "always" }),
      col("by_default", { identity: "by_default" }),
      col("blob", { editable: false }),
      col("password"),
    ];
    const page = columns.map((c) => ({ name: c.name, masked: c.name === "password" }));
    expect(matchingSetChoices(info(columns), page).map((c) => c.name)).toEqual([
      "status",
      "by_default",
    ]);
    // Revealed on the page, it is offered.
    const revealed = page.map((c) => ({ ...c, masked: false }));
    expect(matchingSetChoices(info(columns), revealed).map((c) => c.name)).toContain("password");
  });
});

describe("the changes", () => {
  const table = { schema: "public", name: "t" };

  it("carry the filter as the grid reads with it, and pass the shared schema", () => {
    const update = buildUpdateMatching(table, [filter], ["password"], "status", null);
    expect(update).toEqual({
      kind: "update_matching",
      table,
      filters: [filter],
      revealColumns: ["password"],
      set: { column: "status", value: null },
    });
    expect(changeSchema.safeParse(update).success).toBe(true);
    const del = buildDeleteMatching(table, [filter], []);
    expect(del).toEqual({ kind: "delete_matching", table, filters: [filter], revealColumns: [] });
    expect(changeSchema.safeParse(del).success).toBe(true);
  });

  it("is refused by the shared schema with an empty filter", () => {
    expect(changeSchema.safeParse(buildDeleteMatching(table, [], [])).success).toBe(false);
  });
});
