import type { RowPage } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { pageNotes } from "./page-notes";

const page = (overrides: Partial<RowPage> = {}): RowPage => ({
  columns: [
    { name: "id", dataType: "integer", masked: false, kind: "ordered" },
    { name: "email", dataType: "text", masked: false, kind: "text" },
  ],
  rows: [],
  nextCursor: null,
  order: { kind: "primary_key", columns: ["id"] },
  hiddenColumns: 0,
  cutBySize: false,
  offsetCapped: false,
  rowSecurity: "off",
  sort: null,
  filters: [],
  sortValueTooLong: false,
  ...overrides,
});

describe("pageNotes with a sort", () => {
  const sorted = (overrides: Partial<RowPage> = {}) =>
    page({ sort: { column: "email", direction: "desc" }, ...overrides });

  it("says how the page is ordered: the column, the direction, where NULL goes, and the tie-breaker", () => {
    expect(pageNotes(sorted())).toEqual([
      "Ordered by email (descending, NULL first), then by id (the primary key).",
    ]);
    expect(pageNotes(page({ sort: { column: "email", direction: "asc" } }))).toEqual([
      "Ordered by email (ascending, NULL last), then by id (the primary key).",
    ]);
  });

  it("names a unique index as the tie-breaker when there is no primary key", () => {
    expect(pageNotes(sorted({ order: { kind: "unique_index", columns: ["a", "b"] } }))[0]).toBe(
      "Ordered by email (descending, NULL first), then by a, b (a unique index).",
    );
  });

  it("says paging stops, and what to do, when the sort value was too long to continue from", () => {
    const notes = pageNotes(sorted({ sortValueTooLong: true }));
    expect(notes.join(" ")).toContain("Paging stops here");
    expect(notes.join(" ")).toContain("Sort by another column");
  });

  it("does not mention it on a page that was not sorted", () => {
    expect(pageNotes(page()).join(" ")).not.toContain("Paging stops");
    expect(pageNotes(page())).toEqual(["Ordered by id (the primary key)."]);
  });
});

describe("pageNotes", () => {
  it("warns about row-level security only when it applies to the connected role", () => {
    expect(pageNotes(page({ rowSecurity: "applies" })).join(" ")).toContain("Row-level security");
    expect(pageNotes(page({ rowSecurity: "applies" })).join(" ")).toContain("may not be seeing");
    expect(pageNotes(page({ rowSecurity: "exempt" }))).toEqual([
      "Ordered by id (the primary key).",
    ]);
    expect(pageNotes(page({ rowSecurity: "off" }))).toEqual(["Ordered by id (the primary key)."]);
  });

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
      page({ columns: [{ name: "password", dataType: "text", masked: true, kind: "text" }] }),
    );
    expect(one.join(" ")).toContain("A column whose name looks sensitive was not read");
    const two = pageNotes(
      page({
        columns: [
          { name: "password", dataType: "text", masked: true, kind: "text" },
          { name: "api_key", dataType: "text", masked: true, kind: "text" },
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
        columns: [{ name: "password", dataType: "text", masked: true, kind: "text" }],
      }),
    ).join(" ");
    expect(text).not.toContain("SECRET-CELL");
  });
});
