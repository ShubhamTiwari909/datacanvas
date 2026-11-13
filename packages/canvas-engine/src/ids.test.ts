import { describe, expect, it } from "vitest";
import { columnHandleId, nodeIdFor, parseNodeId, tableHandleId } from "./ids.js";

describe("ids", () => {
  it("gives the same node id to the same table", () => {
    expect(nodeIdFor({ schema: "public", name: "users" })).toBe(
      nodeIdFor({ schema: "public", name: "users" }),
    );
  });

  it("does not confuse a dot in a name with the separator between schema and table", () => {
    expect(nodeIdFor({ schema: "a.b", name: "c" })).not.toBe(
      nodeIdFor({ schema: "a", name: "b.c" }),
    );
  });

  it("has different handles for each side and for columns versus the header", () => {
    const handles = new Set([
      columnHandleId("source", "id"),
      columnHandleId("target", "id"),
      columnHandleId("source", "table"),
      tableHandleId("source"),
      tableHandleId("target"),
    ]);
    expect(handles.size).toBe(5); // a column literally named "table" cannot clash with the header handle
  });
});

describe("parseNodeId", () => {
  it("is the inverse of nodeIdFor, even for awkward names", () => {
    for (const ref of [
      { schema: "public", name: "users" },
      { schema: "a.b", name: 'c"d' },
      { schema: "日本", name: "t\n1" },
    ]) {
      expect(parseNodeId(nodeIdFor(ref))).toEqual(ref);
    }
  });

  it.each(["", "users", "[]", '["only-one"]', '["a","b","c"]', "[1,2]", "{}", "null"])(
    "rejects %j",
    (text) => {
      expect(parseNodeId(text)).toBeNull();
    },
  );
});
