/**
 * The contracts of the bulk row changes (`update_rows`, `delete_rows`): strict at every level, bounded at 500
 * rows, every row named once, every changed column carrying the value that was seen. A request cannot hold SQL.
 */
import { describe, expect, it } from "vitest";
import { WRITE_MAX_BULK_ROWS, changeSchema, previewChangeRequestSchema } from "./writes.js";

const table = { schema: "public", name: "items" };
const row = (id: number, seen: string | null = "new") => ({
  key: [{ column: "id", value: String(id) }],
  expected: [{ column: "status", value: seen }],
});
const update = (over: Record<string, unknown> = {}) => ({
  kind: "update_rows",
  table,
  set: [{ column: "status", value: "done" }],
  rows: [row(1), row(2)],
  ...over,
});
const remove = (over: Record<string, unknown> = {}) => ({
  kind: "delete_rows",
  table,
  rows: [{ key: [{ column: "id", value: "1" }] }, { key: [{ column: "id", value: "2" }] }],
  ...over,
});

describe("update_rows", () => {
  it("accepts a well-formed change, NULL included", () => {
    expect(changeSchema.safeParse(update()).success).toBe(true);
    expect(
      changeSchema.safeParse(
        update({ set: [{ column: "status", value: null }], rows: [row(1, null)] }),
      ).success,
    ).toBe(true);
    expect(previewChangeRequestSchema.safeParse({ change: update() }).success).toBe(true);
  });

  it.each([
    ["no rows", { rows: [] }],
    ["nothing to set", { set: [] }],
    [
      "a column set twice",
      {
        set: [
          { column: "a", value: "1" },
          { column: "a", value: "2" },
        ],
      },
    ],
    ["a row without the value that was seen", { rows: [{ ...row(1), expected: [] }] }],
    [
      "a seen value for another column",
      { rows: [{ ...row(1), expected: [{ column: "other", value: "x" }] }] },
    ],
    ["a row named twice", { rows: [row(1), row(1)] }],
    ["a row with no key", { rows: [{ key: [], expected: row(1).expected }] }],
    [
      "a key column twice",
      {
        rows: [
          {
            ...row(1),
            key: [
              { column: "id", value: "1" },
              { column: "id", value: "1" },
            ],
          },
        ],
      },
    ],
    ["a value that is not text or null", { set: [{ column: "status", value: 5 }] }],
  ])("refuses %s", (_name, over) => {
    expect(changeSchema.safeParse(update(over)).success).toBe(false);
  });

  it(`refuses more than ${WRITE_MAX_BULK_ROWS} rows and accepts exactly that many`, () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));
    expect(changeSchema.safeParse(update({ rows: rows(WRITE_MAX_BULK_ROWS) })).success).toBe(true);
    expect(changeSchema.safeParse(update({ rows: rows(WRITE_MAX_BULK_ROWS + 1) })).success).toBe(
      false,
    );
  });

  it.each(["sql", "where", "expression", "using", "returning", "limit", "all"])(
    "refuses a %s anywhere in the request",
    (name) => {
      expect(changeSchema.safeParse(update({ [name]: "1=1" })).success).toBe(false);
      expect(changeSchema.safeParse(update({ table: { ...table, [name]: "x" } })).success).toBe(
        false,
      );
      expect(changeSchema.safeParse(update({ rows: [{ ...row(1), [name]: "x" }] })).success).toBe(
        false,
      );
      expect(
        changeSchema.safeParse(update({ set: [{ column: "status", value: "x", [name]: "y" }] }))
          .success,
      ).toBe(false);
    },
  );
});

describe("delete_rows", () => {
  it("accepts a well-formed change", () => {
    expect(changeSchema.safeParse(remove()).success).toBe(true);
  });

  it.each([
    ["no rows", { rows: [] }],
    [
      "a row named twice",
      { rows: [{ key: [{ column: "id", value: "1" }] }, { key: [{ column: "id", value: "1" }] }] },
    ],
    ["a row with no key", { rows: [{ key: [] }] }],
    [
      "a row with something besides a key",
      { rows: [{ key: [{ column: "id", value: "1" }], expected: [] }] },
    ],
  ])("refuses %s", (_name, over) => {
    expect(changeSchema.safeParse(remove(over)).success).toBe(false);
  });

  it(`refuses more than ${WRITE_MAX_BULK_ROWS} rows`, () => {
    const rows = Array.from({ length: WRITE_MAX_BULK_ROWS + 1 }, (_, i) => ({
      key: [{ column: "id", value: String(i + 1) }],
    }));
    expect(changeSchema.safeParse(remove({ rows })).success).toBe(false);
  });

  it.each(["sql", "where", "all", "confirm"])("refuses a %s anywhere in the request", (name) => {
    expect(changeSchema.safeParse(remove({ [name]: "x" })).success).toBe(false);
  });
});
