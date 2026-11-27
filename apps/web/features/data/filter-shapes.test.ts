import type { RowFilter } from "@datacanvas/database-core";
import { describe, expect, it } from "vitest";
import {
  MAX_SHAPES_PER_TABLE,
  deleteShape,
  loadShapes,
  forgetSessionShapes,
  legacyShapes,
  moveLegacyShapes,
  parseShapes,
  saveShape,
  shapeFromFilters,
  type ShapeStorage,
} from "./filter-shapes";

const scope = { connectionId: "live-a", profileId: "saved-a" };

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
    saveShape(scope, "public", "orders", "Open this week", filters, storage);
    const stored = [...storage.data.values()].join("");
    expect(stored).not.toContain("SECRET");
    expect(stored).toContain("status");
  });
});

describe("saving, loading and deleting", () => {
  it("round-trips per table, and a name replaces the shape of the same name", () => {
    const storage = memory();
    saveShape(scope, "public", "orders", "a", filters.slice(0, 1), storage);
    saveShape(scope, "public", "orders", "b", filters.slice(0, 2), storage);
    saveShape(scope, "public", "orders", "a", filters.slice(2, 3), storage);
    saveShape(scope, "public", "users", "u", filters.slice(0, 1), storage);
    expect(loadShapes(scope, "public", "orders", storage).map((s) => s.name)).toEqual(["b", "a"]);
    expect(loadShapes(scope, "public", "users", storage).map((s) => s.name)).toEqual(["u"]);
    expect(deleteShape(scope, "public", "orders", "b", storage).map((s) => s.name)).toEqual(["a"]);
    expect(loadShapes(scope, "public", "orders", storage)).toHaveLength(1);
  });

  it("refuses an empty name, a long name, no conditions, and a twenty-first shape", () => {
    const storage = memory();
    expect(saveShape(scope, "s", "t", "  ", filters, storage)).toBeNull();
    expect(saveShape(scope, "s", "t", "x".repeat(61), filters, storage)).toBeNull();
    expect(saveShape(scope, "s", "t", "ok", [], storage)).toBeNull();
    for (let i = 0; i < MAX_SHAPES_PER_TABLE; i++)
      saveShape(scope, "s", "t", `n${i}`, filters, storage);
    expect(saveShape(scope, "s", "t", "one more", filters, storage)).toBeNull();
    expect(saveShape(scope, "s", "t", "n3", filters, storage)).not.toBeNull(); // replacing is allowed
  });

  it("remembers nothing, and does not fail, when storage is missing or refuses", () => {
    expect(saveShape(scope, "s", "t", "x", filters, null)).toBeNull();
    expect(loadShapes(scope, "s", "t", null)).toEqual([]);
    const broken: ShapeStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(saveShape(scope, "s", "t", "x", filters, broken)).toBeNull();
    expect(loadShapes(scope, "s", "t", broken)).toEqual([]);
    expect(deleteShape(scope, "s", "t", "x", broken)).toEqual([]);
  });
});

describe("connection scoping", () => {
  it("uses a stable profile identity and keeps profiles and dotted identifiers apart", () => {
    const storage = memory();
    saveShape(scope, "part.one", "orders", "A", filters, storage);
    expect(
      loadShapes({ ...scope, connectionId: "reconnected" }, "part.one", "orders", storage),
    ).toHaveLength(1);
    expect(loadShapes({ ...scope, profileId: "saved-b" }, "part.one", "orders", storage)).toEqual(
      [],
    );
    expect(loadShapes(scope, "part", "one.orders", storage)).toEqual([]);
  });

  it("keeps unsaved filters for the active connection and forgets them on disconnect", () => {
    const temporary = { connectionId: "unsaved-a", profileId: null };
    saveShape(temporary, "public", "orders", "Temporary", filters);
    expect(loadShapes(temporary, "public", "orders")).toHaveLength(1);
    expect(loadShapes({ ...temporary, connectionId: "unsaved-b" }, "public", "orders")).toEqual([]);
    forgetSessionShapes(temporary.connectionId);
    expect(loadShapes(temporary, "public", "orders")).toEqual([]);
  });

  it("moves legacy filters only on request and keeps duplicate names recoverable", () => {
    const storage = memory();
    storage.setItem(
      "datacanvas:filter-shapes:v1:public.orders",
      JSON.stringify([
        { name: "A", conditions: shapeFromFilters(filters) },
        { name: "B", conditions: shapeFromFilters(filters) },
      ]),
    );
    expect(loadShapes(scope, "public", "orders", storage)).toEqual([]);
    saveShape(scope, "public", "orders", "A", filters.slice(0, 1), storage);
    expect(
      moveLegacyShapes(scope, "public", "orders", storage)?.map((shape) => shape.name),
    ).toEqual(["A", "B"]);
    expect(loadShapes(scope, "public", "orders", storage)[0]?.conditions).toHaveLength(1);
    expect(legacyShapes("public", "orders", storage).map((shape) => shape.name)).toEqual(["A"]);
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
