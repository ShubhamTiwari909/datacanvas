import { describe, expect, it } from "vitest";
import { tableRefKey, uniqueTableRefs } from "./table-refs.js";

describe("tableRefKey", () => {
  it("does not collide when names contain dots", () => {
    expect(tableRefKey({ schema: "a.b", name: "c" })).not.toBe(
      tableRefKey({ schema: "a", name: "b.c" }),
    );
  });

  it("is stable for the same table", () => {
    expect(tableRefKey({ schema: "public", name: "users" })).toBe(
      tableRefKey({ schema: "public", name: "users" }),
    );
  });
});

describe("uniqueTableRefs", () => {
  it("keeps the first occurrence and the original order", () => {
    const refs = [
      { schema: "public", name: "b" },
      { schema: "public", name: "a" },
      { schema: "public", name: "b" },
      { schema: "other", name: "b" },
    ];
    expect(uniqueTableRefs(refs)).toEqual([
      { schema: "public", name: "b" },
      { schema: "public", name: "a" },
      { schema: "other", name: "b" },
    ]);
  });

  it("returns an empty list for no tables, and copies its input", () => {
    expect(uniqueTableRefs([])).toEqual([]);
    const input = { schema: "s", name: "t" };
    expect(uniqueTableRefs([input])[0]).not.toBe(input);
  });
});
