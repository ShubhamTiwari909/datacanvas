import { describe, expect, it } from "vitest";
import { estimatedRowCount, relationKindFromRelkind } from "./tables.js";

describe("relationKindFromRelkind", () => {
  it.each([
    ["r", "table"],
    ["p", "table"],
    ["v", "view"],
    ["m", "materialized_view"],
  ] as const)("maps %s to %s", (relkind, kind) => {
    expect(relationKindFromRelkind(relkind)).toBe(kind);
  });
});

describe("estimatedRowCount", () => {
  it("rounds the planner's estimate", () => {
    expect(estimatedRowCount("table", 41.6)).toBe(42);
  });

  it("is null for a never-analysed table (PostgreSQL reports -1)", () => {
    expect(estimatedRowCount("table", -1)).toBeNull();
  });

  it("is null for views, which hold no rows of their own", () => {
    expect(estimatedRowCount("view", 0)).toBeNull();
  });

  it("keeps a real zero for an analysed empty table", () => {
    expect(estimatedRowCount("table", 0)).toBe(0);
  });
});
