/**
 * The contracts of the imports by key (`upsert_rows`, `update_by_key`; `docs/write-side-v2-plan.md`, 4.1 and 4.2):
 * strict at every level, bounded as an import is, every key column mapped, the columns to update mapped and
 * outside the key. A request cannot hold SQL. (The key itself is checked against the catalog by the server.)
 */
import { describe, expect, it } from "vitest";
import {
  WRITE_MAX_CHANGE_PARTS,
  WRITE_MAX_IMPORT_CELL_CHARS,
  WRITE_MAX_IMPORT_COLUMNS,
  WRITE_MAX_IMPORT_ROWS,
  applyChangeResponseSchema,
  changePreviewSchema,
  changeSchema,
  previewChangeRequestSchema,
  tableEditInfoSchema,
} from "./writes.js";

const table = { schema: "public", name: "items" };
const upsert = (over: Record<string, unknown> = {}) => ({
  kind: "upsert_rows",
  table,
  key: ["id"],
  columns: ["id", "name", "qty"],
  rows: [
    ["1", "a", "2"],
    ["2", null, ""],
  ],
  updateColumns: ["name"],
  ...over,
});
const byKey = (over: Record<string, unknown> = {}) => ({
  kind: "update_by_key",
  table,
  key: ["id"],
  columns: ["id", "name"],
  rows: [["1", "a"]],
  ...over,
});

describe("upsert_rows", () => {
  it("accepts a well-formed change, NULL included, with columns to update or none (leave rows alone)", () => {
    expect(changeSchema.safeParse(upsert()).success).toBe(true);
    expect(changeSchema.safeParse(upsert({ updateColumns: [] })).success).toBe(true);
    expect(
      changeSchema.safeParse(upsert({ key: ["name", "id"], updateColumns: ["qty"] })).success,
    ).toBe(true);
    expect(previewChangeRequestSchema.safeParse({ change: upsert() }).success).toBe(true);
  });

  it.each([
    ["no rows", { rows: [] }],
    ["no columns", { columns: [], rows: [[]] }],
    ["no key", { key: [] }],
    ["a key column listed twice", { key: ["id", "id"] }],
    ["a key column that is not mapped", { key: ["code"] }],
    ["a column listed twice", { columns: ["id", "id", "qty"] }],
    ["a row of the wrong length", { rows: [["1", "a"]] }],
    ["a column to update listed twice", { updateColumns: ["name", "name"] }],
    ["a column to update that is not mapped", { updateColumns: ["note"] }],
    ["a column to update that is the key", { updateColumns: ["id"] }],
    ["a cell that is not text", { rows: [["1", 2, "3"]] }],
    ["a cell too long", { rows: [["1", "x".repeat(WRITE_MAX_IMPORT_CELL_CHARS + 1), "3"]] }],
    ["a lone half of a surrogate pair", { rows: [["1", "a\ud800", "3"]] }],
    ["no list of columns to update", { updateColumns: undefined }],
    [
      "a key of too many columns",
      { key: Array.from({ length: WRITE_MAX_CHANGE_PARTS + 1 }, (_, i) => `k${i}`) },
    ],
  ])("refuses %s", (_name, over) => {
    expect(changeSchema.safeParse(upsert(over)).success).toBe(false);
  });

  it("refuses more rows or columns than an import takes", () => {
    const wide = Array.from({ length: WRITE_MAX_IMPORT_COLUMNS + 1 }, (_, i) => `c${i}`);
    expect(
      changeSchema.safeParse(
        upsert({ key: ["c0"], columns: wide, rows: [wide.map(() => "x")], updateColumns: [] }),
      ).success,
    ).toBe(false);
    const tall = Array.from({ length: WRITE_MAX_IMPORT_ROWS + 1 }, () => ["1", "a", "2"]);
    expect(changeSchema.safeParse(upsert({ rows: tall })).success).toBe(false);
  });

  it.each(["sql", "where", "conflict", "set", "returning", "expression", "arbiter"])(
    "refuses a %s anywhere in the request",
    (name) => {
      expect(changeSchema.safeParse(upsert({ [name]: "x" })).success).toBe(false);
      expect(changeSchema.safeParse(upsert({ table: { ...table, [name]: "x" } })).success).toBe(
        false,
      );
    },
  );
});

describe("update_by_key", () => {
  it("accepts a well-formed change", () => {
    expect(changeSchema.safeParse(byKey()).success).toBe(true);
    expect(
      changeSchema.safeParse(
        byKey({ key: ["a", "b"], columns: ["b", "x", "a"], rows: [["1", null, "2"]] }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["no rows", { rows: [] }],
    ["no key", { key: [] }],
    ["a key column that is not mapped", { key: ["code"] }],
    ["only key columns", { columns: ["id"], rows: [["1"]] }],
    ["a column listed twice", { columns: ["id", "id"] }],
    ["a row of the wrong length", { rows: [["1"]] }],
    ["columns to update (every column that is not the key is set)", { updateColumns: ["name"] }],
  ])("refuses %s", (_name, over) => {
    expect(changeSchema.safeParse(byKey(over)).success).toBe(false);
  });

  it.each(["sql", "where", "set", "filter", "expression"])(
    "refuses a %s anywhere in the request",
    (name) => {
      expect(changeSchema.safeParse(byKey({ [name]: "x" })).success).toBe(false);
    },
  );
});

describe("what the browser gets back", () => {
  it("a preview carries counts for an import by key, and null for any other change", () => {
    const base = {
      previewId: "a".repeat(22),
      statement: "x",
      effect: "y",
      warnings: [],
      destructive: true,
      category: "row",
      expiresAt: new Date(0).toISOString(),
    };
    expect(changePreviewSchema.parse(base).counts).toBeNull();
    expect(
      changePreviewSchema.parse({ ...base, counts: { insert: 1, update: 2, unchanged: 0 } }).counts,
    ).toEqual({ insert: 1, update: 2, unchanged: 0 });
  });

  it("an apply result may carry the split of an import by key", () => {
    const entry = {
      id: "1",
      at: new Date(0).toISOString(),
      kind: "upsert_rows",
      table,
      columns: ["id"],
      statement: null,
      outcome: "applied",
      errorCode: null,
    };
    const split = { inserted: 1, updated: 2, exact: false };
    expect(
      applyChangeResponseSchema.parse({ result: { rowCount: 3, entry, split } }).result.split,
    ).toEqual(split);
    expect(
      applyChangeResponseSchema.parse({ result: { rowCount: 3, entry } }).result.split,
    ).toBeUndefined();
  });

  it("edit info may list the keys an import by key can use, names only", () => {
    const info = {
      table,
      editable: true,
      reason: null,
      key: ["id"],
      columns: [],
      triggers: [],
      rowSecurity: false,
      incomingForeignKeys: [],
    };
    expect(tableEditInfoSchema.parse(info).uniqueKeys).toBeUndefined();
    expect(
      tableEditInfoSchema.parse({ ...info, uniqueKeys: [{ name: "items_pkey", columns: ["id"] }] })
        .uniqueKeys,
    ).toEqual([{ name: "items_pkey", columns: ["id"] }]);
  });
});
