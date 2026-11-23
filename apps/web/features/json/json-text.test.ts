import { describe, expect, it } from "vitest";
import { checkJson, formatJson, MAX_JSON_DEPTH } from "./json-text";

describe("checkJson", () => {
  it("accepts every kind of value", () => {
    for (const ok of [
      '{"a": [1, 2.5e3, -0, true, false, null, "x\\n\\u00e9"]}',
      "[]",
      "{}",
      '"s"',
      "0",
      "-1.5E-2",
      "null",
    ]) {
      expect(checkJson(ok).ok, ok).toBe(true);
    }
  });

  it.each([
    ['"\\u0000"', "\\u0000"],
    ['"\\ud800"', "half of a character"],
    ['"\\ud800x"', "half of a character"],
    ['"\\udc00"', "half of a character"],
  ])("refuses %s for jsonb only", (text, words) => {
    expect(checkJson(text).ok, "json").toBe(true);
    const result = checkJson(text, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(words);
  });

  it("accepts a valid surrogate pair in jsonb", () => {
    expect(checkJson('"\\ud83d\\ude00"', true).ok).toBe(true);
  });

  it("names a token by its kind, never its text", () => {
    const result = checkJson('{"secret" "x"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/found a string/);
      expect(result.error.message).not.toContain("secret");
    }
  });

  it("says where it stops, in lines and columns", () => {
    const result = checkJson('{\n  "a": 1,\n  "b": }\n');
    expect(result).toMatchObject({ ok: false, error: { line: 3, column: 8 } });
  });

  it("counts a carriage return, a line feed and both as one line break each", () => {
    expect(checkJson('{\r"a":\r\n x}')).toMatchObject({ ok: false, error: { line: 3, column: 2 } });
  });

  it.each([
    ["", "empty"],
    ["{", "ends"],
    ['{"a" 1}', ":"],
    ['{"a": 1,}', "key"],
    ["[1,]", "value"],
    ["[1 2]", '","'],
    ["{'a': 1}", "single quotes"],
    ["// c\n1", "comments"],
    ["01", "number"],
    ["1.", "number"],
    ["+1", "Unexpected"],
    ["NaN", "Unexpected"],
    ["[1] 2", "end of the document"],
    ['"a', "not closed"],
    ['"a\nb"', "escape"],
    ['"\\x"', "escape"],
    ['"\\u12"', "four hexadecimal"],
    ["tru", "Unexpected"],
    ["truex", "Unexpected"],
  ])("refuses %j", (text, fragment) => {
    const result = checkJson(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(fragment);
  });

  it("limits the depth, so a hostile document cannot exhaust the stack", () => {
    const deep = "[".repeat(MAX_JSON_DEPTH + 5) + "]".repeat(MAX_JSON_DEPTH + 5);
    expect(checkJson(deep).ok).toBe(false);
    const fine = "[".repeat(50) + "]".repeat(50);
    expect(checkJson(fine).ok).toBe(true);
  });
});

describe("formatJson", () => {
  it("indents objects and arrays, keeps empty ones short", () => {
    expect(formatJson('{"a":[1,2],"b":{},"c":[]}')).toBe(
      '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {},\n  "c": []\n}',
    );
  });

  it("minifies", () => {
    expect(formatJson('{\n  "a": [ 1, 2 ],\n  "b": "x y"\n}', 0)).toBe('{"a":[1,2],"b":"x y"}');
  });

  it("keeps every number as written, which JSON.stringify cannot", () => {
    const text =
      '{"big": 12345678901234567890, "dec": 0.1000000000000000055511151231257827, "e": 1E+2}';
    const out = formatJson(text, 0)!;
    expect(out).toContain("12345678901234567890");
    expect(out).toContain("0.1000000000000000055511151231257827");
    expect(out).toContain("1E+2");
    expect(JSON.stringify(JSON.parse(text))).not.toContain("12345678901234567890");
  });

  it("keeps strings exactly, escapes and all", () => {
    const text = '{"s": "a\\"b\\\\c\\u00e9\\/"}';
    expect(formatJson(text, 0)).toBe('{"s":"a\\"b\\\\c\\u00e9\\/"}');
  });

  it("is idempotent and gives null for what is not JSON", () => {
    const once = formatJson('[{"a":1},{"b":[true,null]}]')!;
    expect(formatJson(once)).toBe(once);
    expect(formatJson("{")).toBeNull();
  });
});
