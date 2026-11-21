import { describe, expect, it } from "vitest";
import { countChanges, diffDocuments, diffLines, DIFF_MAX_LINES } from "./json-diff";
import { JSON_TOKEN_RULES } from "./json-language";
import {
  buildJsonTree,
  pathSteps,
  pathText,
  TREE_MAX_NODES,
  TREE_STRING_CHARS,
  type TreeNode,
} from "./json-tree";

describe("buildJsonTree", () => {
  it("is null for a document that is not JSON", () => {
    expect(buildJsonTree('{"a": }')).toBeNull();
    expect(buildJsonTree("")).toBeNull();
  });

  it("shows objects and arrays with their sizes, and every value as it is written", () => {
    const tree = buildJsonTree(
      '{"a": [1, 2.50, "x"], "b": {}, "c": null, "d": 12345678901234567890}',
    )!;
    expect(tree.truncated).toBe(false);
    expect(tree.root).toMatchObject({ kind: "object", preview: "{4 keys}", step: null });
    const [a, b, c, d] = tree.root.children as [TreeNode, TreeNode, TreeNode, TreeNode];
    expect(a).toMatchObject({ step: "a", kind: "array", preview: "[3 items]" });
    expect(a.children.map((n) => n.preview)).toEqual(["1", "2.50", '"x"']);
    expect(a.children.map((n) => n.step)).toEqual([0, 1, 2]);
    expect(b).toMatchObject({ kind: "object", preview: "{0 keys}", children: [] });
    expect(c).toMatchObject({ kind: "literal", preview: "null" });
    // A large number keeps its digits: it is never turned into a double.
    expect(d.preview).toBe("12345678901234567890");
  });

  it("says one key or one item in the singular", () => {
    expect(buildJsonTree('{"a": 1}')!.root.preview).toBe("{1 key}");
    expect(buildJsonTree("[1]")!.root.preview).toBe("[1 item]");
  });

  it("cuts a long string for display and keeps its whole text", () => {
    const long = "x".repeat(TREE_STRING_CHARS + 20);
    const node = buildJsonTree(JSON.stringify({ s: long }))!.root.children[0]!;
    expect(node.cut).toBe(true);
    expect(node.preview.endsWith("…")).toBe(true);
    expect(node.preview.length).toBeLessThan(long.length);
    expect(node.text).toBe(JSON.stringify(long));
  });

  it("reads keys with escapes and handles a scalar document", () => {
    const tree = buildJsonTree('{"a\\"b": 1, "ü": 2}')!;
    expect(tree.root.children.map((n) => n.step)).toEqual(['a"b', "ü"]);
    expect(buildJsonTree("42")!.root).toMatchObject({ kind: "number", preview: "42", step: null });
  });

  it("stops keeping nodes past its limit and says so, but still counts the keys", () => {
    const items = Array.from({ length: TREE_MAX_NODES + 50 }, (_, i) => i);
    const tree = buildJsonTree(JSON.stringify(items))!;
    expect(tree.truncated).toBe(true);
    expect(tree.root.preview).toBe(`[${TREE_MAX_NODES + 50} items]`);
    expect(tree.root.children.length).toBeLessThanOrEqual(TREE_MAX_NODES);
  });

  it("walks a deep document without trouble (the checker's own depth limit applies)", () => {
    expect(buildJsonTree("[".repeat(150) + "]".repeat(150))).not.toBeNull();
    expect(buildJsonTree("[".repeat(250) + "]".repeat(250))).toBeNull();
  });
});

describe("pathText", () => {
  it("writes keys after dots, indexes in brackets, and odd keys in quotes", () => {
    expect(pathText([])).toBe("$");
    expect(pathText(["a", 0, "b_2"])).toBe("$.a[0].b_2");
    expect(pathText(["weird key", "x.y", "9a", 'q"uote'])).toBe(
      '$."weird key"."x.y"."9a"."q\\"uote"',
    );
  });

  it("gives the steps as text, the form a path filter takes", () => {
    expect(pathSteps(["a", 0, "b"])).toEqual(["a", "0", "b"]);
  });
});

describe("diffLines", () => {
  it("marks what was removed and what was added, keeping the lines that stayed", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c"])).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });

  it("handles an empty side and identical sides", () => {
    expect(diffLines([], ["a"])).toEqual([{ kind: "added", text: "a" }]);
    expect(diffLines(["a"], [])).toEqual([{ kind: "removed", text: "a" }]);
    expect(countChanges(diffLines(["a", "b"], ["a", "b"])!)).toEqual({ added: 0, removed: 0 });
  });

  it("gives up on documents that are too long to compare", () => {
    const long = Array.from({ length: DIFF_MAX_LINES + 1 }, (_, i) => String(i));
    expect(diffLines(long, ["x"])).toBeNull();
    expect(diffLines(["x"], long)).toBeNull();
  });
});

describe("diffDocuments", () => {
  it("lays both sides out the same way first, so spacing alone is not a change", () => {
    const lines = diffDocuments('{"a":1,"b":[1,2]}', '{\n  "a": 1,\n  "b": [1, 2]\n}')!;
    // The two spellings are the same document laid out the same way: no line differs.
    expect(countChanges(lines)).toEqual({ added: 0, removed: 0 });
  });

  it("shows a changed value as one line out and one line in", () => {
    const lines = diffDocuments('{"a": 1, "b": 2}', '{"a": 1, "b": 3}')!;
    expect(countChanges(lines)).toEqual({ added: 1, removed: 1 });
    expect(lines.filter((l) => l.kind !== "same").map((l) => l.text.trim())).toEqual([
      '"b": 2',
      '"b": 3',
    ]);
  });

  it("compares the text as it is when one side is not valid JSON", () => {
    expect(countChanges(diffDocuments('{"a": 1}', '{"a": ')!).added).toBeGreaterThan(0);
  });
});

/** Run the tokenizer's rules over one line, the way Monarch does: the first rule that matches here wins. */
function tokensOf(line: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let at = 0;
  while (at < line.length) {
    let matched = false;
    for (const [regex, token] of JSON_TOKEN_RULES) {
      const sticky = new RegExp(regex.source, "y");
      sticky.lastIndex = at;
      const m = sticky.exec(line);
      if (m && m[0].length > 0) {
        if (token !== "white") out.push([token, m[0]]);
        at += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push(["invalid", line[at]!]);
      at += 1;
    }
  }
  return out;
}

describe("the editor's tokenizer rules", () => {
  it("tells a key from a string value by the colon after it", () => {
    expect(tokensOf('{"a": "b"}')).toEqual([
      ["@brackets", "{"],
      ["string.key.json", '"a"'],
      ["delimiter", ":"],
      ["string.value.json", '"b"'],
      ["@brackets", "}"],
    ]);
  });

  it("colours numbers, words and brackets", () => {
    expect(tokensOf("[1, -2.5e3, true, false, null]").map(([t]) => t)).toEqual([
      "@brackets",
      "number.json",
      "delimiter",
      "number.json",
      "delimiter",
      "keyword.json",
      "delimiter",
      "keyword.json",
      "delimiter",
      "keyword.json",
      "@brackets",
    ]);
  });

  it("keeps an escaped quote inside a string, and a colon inside a string value", () => {
    expect(tokensOf('"a\\"b: c"')).toEqual([["string.value.json", '"a\\"b: c"']]);
  });

  it("marks a string that is not closed on its line, and anything that is not JSON", () => {
    expect(tokensOf('"open')).toEqual([["string.invalid", '"open']]);
    expect(tokensOf("'x'").every(([t]) => t === "invalid")).toBe(true);
  });
});
