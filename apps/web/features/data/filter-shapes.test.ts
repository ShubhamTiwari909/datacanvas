import type { RowFilter } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  MAX_SHAPES_PER_TABLE,
  deleteShape,
  loadShapes,
  parseShapes,
  saveShape,
  shapeFromFilters,
  type ShapeStorage,
} from "./filter-shapes";

const memory = (): ShapeStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

const filters: RowFilter[] = [
  { column: "status", op: "eq", value: "SECRET-VALUE" },
  { column: "tags", op: "array_contains", values: ["SECRET-ITEM"], group: 1 },
  { column: "created", op: "last_7_days", group: 1 },
  { column: "doc", op: "json_path_eq", path: ["SECRET-STEP"], value: "SECRET-VALUE" },
];

describe("a shape", () => {
  it("keeps the columns, the conditions and the groups, and no value, list or path", () => {
    expect(shapeFromFilters(filters)).toEqual([
      { column: "status", op: "eq" },
      { column: "tags", op: "array_contains", group: 1 },
      { column: "created", op: "last_7_days", group: 1 },
      { column: "doc", op: "json_path_eq" },
    ]);
  });

  it("is stored without any of what the person typed", () => {
    const storage = memory();
    saveShape("public", "orders", "Open this week", filters, storage);
    const stored = [...storage.data.values()].join("");
    expect(stored).not.toContain("SECRET");
    expect(stored).toContain("status");
  });
});

describe("saving, loading and deleting", () => {
  it("round-trips per table, and a name replaces the shape of the same name", () => {
    const storage = memory();
    saveShape("public", "orders", "a", filters.slice(0, 1), storage);
    saveShape("public", "orders", "b", filters.slice(0, 2), storage);
    saveShape("public", "orders", "a", filters.slice(2, 3), storage);
    saveShape("public", "users", "u", filters.slice(0, 1), storage);
    expect(loadShapes("public", "orders", storage).map((s) => s.name)).toEqual(["b", "a"]);
    expect(loadShapes("public", "users", storage).map((s) => s.name)).toEqual(["u"]);
    expect(deleteShape("public", "orders", "b", storage).map((s) => s.name)).toEqual(["a"]);
    expect(loadShapes("public", "orders", storage)).toHaveLength(1);
  });

  it("refuses an empty name, a long name, no conditions, and a twenty-first shape", () => {
    const storage = memory();
    expect(saveShape("s", "t", "  ", filters, storage)).toBeNull();
    expect(saveShape("s", "t", "x".repeat(61), filters, storage)).toBeNull();
    expect(saveShape("s", "t", "ok", [], storage)).toBeNull();
    for (let i = 0; i < MAX_SHAPES_PER_TABLE; i++) saveShape("s", "t", `n${i}`, filters, storage);
    expect(saveShape("s", "t", "one more", filters, storage)).toBeNull();
    expect(saveShape("s", "t", "n3", filters, storage)).not.toBeNull(); // replacing is allowed
  });

  it("remembers nothing, and does not fail, when storage is missing or refuses", () => {
    expect(saveShape("s", "t", "x", filters, null)).toBeNull();
    expect(loadShapes("s", "t", null)).toEqual([]);
    const broken: ShapeStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(saveShape("s", "t", "x", filters, broken)).toBeNull();
    expect(loadShapes("s", "t", broken)).toEqual([]);
    expect(deleteShape("s", "t", "x", broken)).toEqual([]);
  });
});

describe("what is read back is untrusted", () => {
  it("ignores text that is not JSON, not a list, or not well formed, and keeps the good ones", () => {
    expect(parseShapes(null)).toEqual([]);
    expect(parseShapes("not json")).toEqual([]);
    expect(parseShapes('{"a":1}')).toEqual([]);
    const text = JSON.stringify([
      { name: "good", conditions: [{ column: "a", op: "eq" }] },
      { name: "", conditions: [{ column: "a", op: "eq" }] },
      { name: "no conditions", conditions: [] },
      { name: "bad op", conditions: [{ column: "a", op: "DROP" }] },
      { name: "bad group", conditions: [{ column: "a", op: "eq", group: 9 }] },
      { name: "bad column", conditions: [{ column: 5, op: "eq" }] },
      { name: "extra", conditions: [{ column: "a", op: "eq", value: "kept out" }] },
      7,
      null,
    ]);
    const shapes = parseShapes(text);
    expect(shapes.map((s) => s.name)).toEqual(["good", "extra"]);
    expect(JSON.stringify(shapes)).not.toContain("kept out");
  });
});
