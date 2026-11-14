import { describe, expect, it } from "vitest";
import { MAX_OBJECT_TEXT, type DatabaseObjects, type FunctionInfo } from "./models.js";
import {
  clipText,
  fingerprint,
  safeSlice,
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
  it("keeps text up to the limit unchanged", () => {
    const exact = "x".repeat(MAX_OBJECT_TEXT);
    expect(clipText(exact)).toBe(exact);
  });

  it("cuts longer text to the limit, ending with its length and a fingerprint of the whole", () => {
    const cut = clipText("x".repeat(MAX_OBJECT_TEXT + 5000));
    expect(cut.length).toBeLessThanOrEqual(MAX_OBJECT_TEXT);
    expect(cut).toMatch(/\.\.\. \[text cut: 25000 characters, fingerprint [0-9a-f]{14}\]$/);
  });

  it("gives different results for long texts that differ only after the cut", () => {
    const head = "x".repeat(MAX_OBJECT_TEXT + 100);
    expect(clipText(`${head}A`)).not.toBe(clipText(`${head}B`));
    expect(clipText(`${head}A`)).toBe(clipText(`${head}A`));
  });

  it("does not change text it already cut (cutting twice is the same as once)", () => {
    const once = clipText("y".repeat(MAX_OBJECT_TEXT * 2));
    expect(clipText(once)).toBe(once);
  });

  it("never cuts an emoji in half, wherever the cut falls", () => {
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    // The cut falls about 70 characters before the limit; try every position around it.
    for (let offset = 40; offset <= 100; offset += 1) {
      const text = `${"a".repeat(MAX_OBJECT_TEXT - offset)}😀${"b".repeat(400)}`;
      const cut = clipText(text);
      expect(cut.length).toBeLessThanOrEqual(MAX_OBJECT_TEXT);
      expect(loneSurrogate.test(cut), `offset ${offset}`).toBe(false);
    }
  });
});

describe("fingerprint and safeSlice", () => {
  it("is stable and sensitive to every character", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
    expect(fingerprint("")).toMatch(/^[0-9a-f]{14}$/);
    expect(fingerprint("ab")).not.toBe(fingerprint("ba"));
  });

  it("drops a half pair at the end instead of keeping it", () => {
    expect(safeSlice("a😀b", 2)).toBe("a"); // would end inside the pair
    expect(safeSlice("a😀b", 3)).toBe("a😀");
    expect(safeSlice("abc", 0)).toBe("");
    expect(safeSlice("abc", 99)).toBe("abc");
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
    expect(result.functions[0]!.definition.length).toBeLessThanOrEqual(MAX_OBJECT_TEXT);
    expect(result.functions[0]!.definition).toContain("text cut: 60000 characters");
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
