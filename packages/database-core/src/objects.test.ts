import { describe, expect, it } from "vitest";
import { MAX_OBJECT_TEXT, type DatabaseObjects, type FunctionInfo } from "./models.js";
import {
  clipText,
  displayName,
  emptyObjects,
  functionKey,
  normalizeObjects,
  triggerKey,
} from "./objects.js";
import { createEcommerceData } from "./testing/index.js";

const fn = (name: string, args = "", o: Partial<FunctionInfo> = {}): FunctionInfo => ({
  schema: "public",
  name,
  kind: "function",
  arguments: args,
  returns: "integer",
  language: "sql",
  volatility: "volatile",
  securityDefiner: false,
  comment: null,
  definition: `CREATE FUNCTION ${name}(${args})`,
  ...o,
});
const withFunctions = (functions: FunctionInfo[]): DatabaseObjects => ({
  ...emptyObjects(),
  functions,
});

describe("clipText", () => {
  it("keeps text up to the limit and cuts longer text visibly", () => {
    const exact = "x".repeat(MAX_OBJECT_TEXT);
    expect(clipText(exact)).toBe(exact);
    const cut = clipText(`${exact}y`);
    expect(cut).toHaveLength(MAX_OBJECT_TEXT);
    expect(cut.endsWith("...")).toBe(true);
  });
});

describe("normalizeObjects", () => {
  it("sorts every list, whatever order the database answered in", () => {
    const sorted = normalizeObjects(withFunctions([fn("b"), fn("a", "x integer"), fn("a")]));
    expect(sorted.functions.map((f) => `${f.name}(${f.arguments})`)).toEqual([
      "a()",
      "a(x integer)",
      "b()",
    ]);
  });

  it("is the same value for the same objects in any order", () => {
    const data = createEcommerceData().objects;
    const reversed: DatabaseObjects = {
      views: [...data.views].reverse(),
      types: [...data.types].reverse(),
      sequences: [...data.sequences].reverse(),
      functions: [...data.functions].reverse(),
      triggers: [...data.triggers].reverse(),
      extensions: [...data.extensions].reverse(),
      policies: [...data.policies].reverse(),
      rowSecurity: [...data.rowSecurity].reverse(),
    };
    expect(normalizeObjects(reversed)).toEqual(normalizeObjects(data));
  });

  it("sorts what a view reads and the roles of a policy", () => {
    const data = createEcommerceData().objects;
    const view = { ...data.views[0]!, dependsOn: [...data.views[0]!.dependsOn].reverse() };
    const policy = { ...data.policies[0]!, roles: ["zed", "alice"] };
    const result = normalizeObjects({ ...data, views: [view], policies: [policy] });
    expect(result.views[0]!.dependsOn.map((d) => d.name)).toEqual(
      data.views[0]!.dependsOn.map((d) => d.name),
    );
    expect(result.policies[0]!.roles).toEqual(["alice", "zed"]);
  });

  it("cuts over-long definitions so a snapshot stays bounded", () => {
    const result = normalizeObjects(
      withFunctions([fn("big", "", { definition: "z".repeat(MAX_OBJECT_TEXT * 3) })]),
    );
    expect(result.functions[0]!.definition).toHaveLength(MAX_OBJECT_TEXT);
  });

  it("does not change its input", () => {
    const input = withFunctions([fn("b"), fn("a")]);
    normalizeObjects(input);
    expect(input.functions.map((f) => f.name)).toEqual(["b", "a"]);
  });
});

describe("identity of objects", () => {
  it("tells overloads apart but not two views of one name", () => {
    expect(functionKey(fn("f", "a integer"))).not.toBe(functionKey(fn("f", "a text")));
    expect(functionKey(fn("f", "a integer"))).toBe(functionKey(fn("f", "a integer")));
  });

  it("does not let a joined pair of names collide with another pair", () => {
    const a = triggerKey({ schema: "s", table: "ab", name: "c" });
    const b = triggerKey({ schema: "s", table: "a", name: "bc" });
    expect(a).not.toBe(b);
  });

  it("names objects for display", () => {
    expect(displayName.functions(fn("add", "a integer"))).toBe("public.add(a integer)");
    expect(displayName.triggers({ ...createEcommerceData().objects.triggers[0]! })).toBe(
      "public.orders.orders_touch",
    );
  });
});
