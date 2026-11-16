import type { RowPage } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { pageNotes } from "./page-notes";

const page = (overrides: Partial<RowPage> = {}): RowPage => ({
  columns: [
    { name: "id", dataType: "integer", masked: false },
    { name: "email", dataType: "text", masked: false },
  ],
  rows: [],
  nextCursor: null,
  order: { kind: "primary_key", columns: ["id"] },
  hiddenColumns: 0,
  cutBySize: false,
  offsetCapped: false,
  ...overrides,
});

describe("pageNotes", () => {
  it("says how a table with a key is ordered", () => {
    expect(pageNotes(page())).toEqual(["Ordered by id (the primary key)."]);
    expect(pageNotes(page({ order: { kind: "unique_index", columns: ["a", "b"] } }))).toEqual([
      "Ordered by a, b (a unique index).",
    ]);
  });

  it("warns that a table without a key has no guaranteed order and a depth limit", () => {
    const [note] = pageNotes(page({ order: { kind: "none", columns: [] } }));
    expect(note).toContain("no key to order by");
    expect(note).toContain("not guaranteed");
    expect(note).toContain("10,000");
  });

  it("says how many columns were left out", () => {
    expect(pageNotes(page({ hiddenColumns: 201 }))).toContain(
      "Showing the first 2 of 203 columns.",
    );
  });

  it("says when columns were hidden because their names look sensitive, singular and plural", () => {
    const one = pageNotes(
      page({ columns: [{ name: "password", dataType: "text", masked: true }] }),
    );
    expect(one.join(" ")).toContain("A column whose name looks sensitive was not read");
    const two = pageNotes(
      page({
        columns: [
          { name: "password", dataType: "text", masked: true },
          { name: "api_key", dataType: "text", masked: true },
        ],
      }),
    );
    expect(two.join(" ")).toContain("2 columns whose names look sensitive were not read");
  });

  it("says when a page was shortened, or when the depth limit was reached", () => {
    expect(pageNotes(page({ cutBySize: true })).join(" ")).toContain("shortened");
    const capped = pageNotes(page({ order: { kind: "none", columns: [] }, offsetCapped: true }));
    expect(capped.join(" ")).toContain("past the first 10,000");
  });

  it("never mentions a value: only names, counts and limits", () => {
    const text = pageNotes(
      page({
        rows: [
          [
            { value: "SECRET-CELL", truncated: false },
            { value: "x", truncated: false },
          ],
        ],
        columns: [{ name: "password", dataType: "text", masked: true }],
      }),
    ).join(" ");
    expect(text).not.toContain("SECRET-CELL");
  });
});
