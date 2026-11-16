import type { RowColumn, RowOrder } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import { describeSort, nextSort, sortActionLabel, sortStateOf, whyNotSortable } from "./sorting";

const keyed: RowOrder = { kind: "primary_key", columns: ["id"] };
const unique: RowOrder = { kind: "unique_index", columns: ["a", "b"] };
const none: RowOrder = { kind: "none", columns: [] };
const col = (name: string, kind: RowColumn["kind"], masked = false): RowColumn => ({
  name,
  dataType: "x",
  masked,
  kind,
});

describe("the state of a column's sort", () => {
  it("is ascending or descending for the sorted column, and none for every other", () => {
    expect(sortStateOf({ column: "a", direction: "asc" }, "a")).toBe("ascending");
    expect(sortStateOf({ column: "a", direction: "desc" }, "a")).toBe("descending");
    expect(sortStateOf({ column: "a", direction: "asc" }, "b")).toBe("none");
    expect(sortStateOf(null, "a")).toBe("none");
  });
});

describe("what activating a header does", () => {
  it("cycles ascending, descending, then back to the key order", () => {
    const first = nextSort(null, "a");
    expect(first).toEqual({ column: "a", direction: "asc" });
    const second = nextSort(first, "a");
    expect(second).toEqual({ column: "a", direction: "desc" });
    expect(nextSort(second, "a")).toBeNull();
  });

  it("starts another column at ascending, whatever the first one was doing", () => {
    expect(nextSort({ column: "a", direction: "desc" }, "b")).toEqual({
      column: "b",
      direction: "asc",
    });
  });

  it("says in the tooltip what the next activation will do", () => {
    expect(sortActionLabel(null, "a")).toBe("Sort ascending");
    expect(sortActionLabel({ column: "a", direction: "asc" }, "a")).toBe("Sort descending");
    expect(sortActionLabel({ column: "a", direction: "desc" }, "a")).toBe("Remove the sort");
    expect(sortActionLabel({ column: "a", direction: "desc" }, "b")).toBe("Sort ascending");
  });
});

describe("why a column cannot be sorted", () => {
  it("is null for a text or ordered column of a table with a key", () => {
    expect(whyNotSortable(col("name", "text"), keyed)).toBeNull();
    expect(whyNotSortable(col("id", "ordered"), unique)).toBeNull();
  });

  it("says a hidden column must be shown first, before anything else", () => {
    expect(whyNotSortable(col("password", "text", true), keyed)).toMatch(/hidden.*Show it first/);
    expect(whyNotSortable(col("password", "text", true), none)).toMatch(/hidden/);
  });

  it("says a table without a key cannot be sorted reliably", () => {
    expect(whyNotSortable(col("name", "text"), none)).toMatch(/no primary key or unique index/);
  });

  it("says the values of an unsortable type have no useful order", () => {
    expect(whyNotSortable(col("data", "other"), keyed)).toMatch(/no useful order/);
  });
});

describe("a sort in words", () => {
  it("names the direction, where NULL goes and the tie-breaker", () => {
    expect(describeSort({ column: "city", direction: "asc" }, keyed)).toBe(
      "city (ascending, NULL last), then by id (the primary key)",
    );
    expect(describeSort({ column: "city", direction: "desc" }, unique)).toBe(
      "city (descending, NULL first), then by a, b (a unique index)",
    );
  });
});
