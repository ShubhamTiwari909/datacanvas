import type { Change, UpsertRowsChange } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { appliedText, countsText, isKeyedImport, skippedText } from "./keyed-text";

const table = { schema: "public", name: "stock" };
const upsert = (updateColumns: string[]): UpsertRowsChange => ({
  kind: "upsert_rows",
  table,
  key: ["sku"],
  columns: ["sku", "qty"],
  rows: [["secret-sku", "secret-qty"]],
  updateColumns,
});
const update: Change = {
  kind: "update_by_key",
  table,
  key: ["sku"],
  columns: ["sku", "qty"],
  rows: [["secret-sku", "secret-qty"]],
};
const insert: Change = { kind: "insert_rows", table, columns: ["sku"], rows: [["secret-sku"]] };

describe("countsText", () => {
  it("says what an update or insert will do, in either form", () => {
    expect(countsText(upsert(["qty"]), { insert: 3, update: 2, unchanged: 0 })).toBe(
      "3 rows will be added and 2 rows overwritten.",
    );
    expect(countsText(upsert(["qty"]), { insert: 1, update: 1, unchanged: 0 })).toBe(
      "1 row will be added and 1 row overwritten.",
    );
    expect(countsText(upsert([]), { insert: 1, update: 0, unchanged: 4 })).toBe(
      "1 row will be added; 4 rows already exist and are left as they are.",
    );
    expect(countsText(upsert([]), { insert: 2, update: 0, unchanged: 1 })).toBe(
      "2 rows will be added; 1 row already exists and is left as it is.",
    );
    expect(countsText(update, { insert: 0, update: 1_500, unchanged: 0 })).toBe(
      "1,500 rows will be updated.",
    );
  });

  it("says nothing without counts or for another change", () => {
    expect(countsText(upsert(["qty"]), null)).toBeNull();
    expect(countsText(insert, { insert: 1, update: 0, unchanged: 0 })).toBeNull();
  });
});

describe("skippedText", () => {
  it("names the file's lines of the rows left out", () => {
    expect(skippedText([1], [2, 4, 5])).toBe(
      "1 row of the file finds no row and is left out (line 4).",
    );
    expect(skippedText([0, 2], [2, 4, 5])).toBe(
      "2 rows of the file find no row and are left out (lines 2, 5).",
    );
  });

  it("lists the first 20 and counts the rest", () => {
    const skipped = Array.from({ length: 25 }, (_, i) => i);
    const lines = skipped.map((i) => i + 2);
    const text = skippedText(skipped, lines);
    expect(text).toContain("lines 2, 3,");
    expect(text).toContain(", 21 and 5 more).");
    expect(text).not.toContain(" 22");
  });

  it("counts from 1 when the lines are not known", () => {
    expect(skippedText([0, 4])).toBe(
      "2 rows of the file find no row and are left out (rows 1, 5).",
    );
  });
});

describe("appliedText", () => {
  it("says how the rows split, and that it is an estimate when the database could not count", () => {
    expect(
      appliedText(upsert(["qty"]), {
        rowCount: 5,
        split: { inserted: 2, updated: 3, exact: true },
      }),
    ).toBe("2 rows were added and 3 updated.");
    expect(
      appliedText(upsert(["qty"]), {
        rowCount: 5,
        split: { inserted: 2, updated: 3, exact: false },
      }),
    ).toBe("5 rows were added or updated: about 2 added and about 3 updated.");
    expect(
      appliedText(upsert([]), { rowCount: 1, split: { inserted: 1, updated: 0, exact: true } }),
    ).toBe("1 row was added; the rows already in the table were left as they are.");
    expect(
      appliedText(update, { rowCount: 4, split: { inserted: 0, updated: 4, exact: true } }),
    ).toBe("4 rows were updated.");
  });

  it("says the total when there is no split", () => {
    expect(appliedText(upsert(["qty"]), { rowCount: 7 })).toBe("7 rows were added or updated.");
    expect(appliedText(update, { rowCount: 1 })).toBe("1 row was updated.");
  });

  it("never holds a value", () => {
    for (const text of [
      countsText(upsert(["qty"]), { insert: 1, update: 1, unchanged: 0 }),
      skippedText([0]),
      appliedText(upsert(["qty"]), { rowCount: 1 }),
    ]) {
      expect(text).not.toContain("secret");
    }
  });
});

describe("isKeyedImport", () => {
  it("is true for the two imports by key only", () => {
    expect(isKeyedImport(upsert([]))).toBe(true);
    expect(isKeyedImport(update)).toBe(true);
    expect(isKeyedImport(insert)).toBe(false);
  });
});
