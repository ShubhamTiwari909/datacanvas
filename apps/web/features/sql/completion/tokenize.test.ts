import { describe, expect, it } from "vitest";
import { insideStringOrComment, nameOf, tokenize } from "./tokenize";

const kinds = (text: string) => tokenize(text).map((t) => `${t.type}:${t.text}`);

describe("tokenize", () => {
  it("splits words, numbers and punctuation, with offsets", () => {
    expect(kinds("SELECT a.b, 12 FROM t;")).toEqual([
      "word:SELECT",
      "word:a",
      "punct:.",
      "word:b",
      "punct:,",
      "number:12",
      "word:FROM",
      "word:t",
      "punct:;",
    ]);
    const [first, second] = tokenize("SELECT x");
    expect([first!.start, first!.end, second!.start, second!.end]).toEqual([0, 6, 7, 8]);
  });

  it("reads strings with doubled quotes, quoted names, and dollar quotes as one token", () => {
    expect(kinds(`'it''s' "a ""b""" $$x; y$$ $tag$z$tag$`)).toEqual([
      "string:'it''s'",
      'quoted:"a ""b"""',
      "string:$$x; y$$",
      "string:$tag$z$tag$",
    ]);
  });

  it("reads line comments and nested block comments", () => {
    expect(kinds("a -- b c\nd /* x /* y */ z */ e")).toEqual([
      "word:a",
      "comment:-- b c",
      "word:d",
      "comment:/* x /* y */ z */",
      "word:e",
    ]);
  });

  it("marks what was never closed", () => {
    for (const text of ["'abc", '"abc', "/* abc", "$$ abc"]) {
      expect(tokenize(text)).toHaveLength(1);
      expect(tokenize(text)[0]!.open).toBe(true);
    }
    expect(tokenize("'abc'")[0]!.open).toBe(false);
  });

  it("treats a letter beyond ASCII as part of a word", () => {
    expect(kinds("SELECT café, 名前")).toEqual([
      "word:SELECT",
      "word:café",
      "punct:,",
      "word:名前",
    ]);
  });

  it("does not hang or throw on odd input", () => {
    for (const text of ["", "$", "$a", "--", "/*", '"', "'", "\u0000", "a".repeat(10_000)]) {
      expect(() => tokenize(text)).not.toThrow();
    }
  });
});

describe("nameOf", () => {
  it("removes the quotes of a quoted name and undoubles quotes", () => {
    expect(nameOf(tokenize('"a ""b"""')[0]!)).toBe('a "b"');
    expect(nameOf(tokenize('"abc')[0]!)).toBe("abc");
    expect(nameOf(tokenize("abc")[0]!)).toBe("abc");
  });
});

describe("insideStringOrComment", () => {
  const at = (text: string) =>
    insideStringOrComment(tokenize(text.replace("|", "")), text.indexOf("|"));
  it("knows where the cursor is", () => {
    expect(at("'ab|c'")).toBe(true);
    expect(at("'abc'|")).toBe(false);
    expect(at("|'abc'")).toBe(false);
    expect(at("'abc|")).toBe(true);
    expect(at("-- x|")).toBe(true);
    expect(at("-- x\n|")).toBe(false);
    expect(at("/* a|")).toBe(true);
    expect(at("/* a */|")).toBe(false);
    expect(at("SELECT |")).toBe(false);
  });
});

describe("strings PostgreSQL has", () => {
  it("reads a backslash in E'...' as an escape, and not in '...'", () => {
    expect(kinds("E'it\\'s' x")).toEqual(["word:E", "string:'it\\'s'", "word:x"]);
    expect(kinds("e'a\\\\' x")).toEqual(["word:e", "string:'a\\\\'", "word:x"]);
    // A plain string ends at the second quote: the backslash is an ordinary character.
    expect(kinds("'it\\' x")).toEqual(["string:'it\\'", "word:x"]);
    // An E that ends a longer word is not the E of an escape string.
    expect(kinds("ONE'a\\' x")).toEqual(["word:ONE", "string:'a\\'", "word:x"]);
  });

  it("reads dollar-quoted strings with digits and long tags", () => {
    expect(kinds("$a1$ x; y $a1$ z")).toEqual(["string:$a1$ x; y $a1$", "word:z"]);
    expect(kinds("$very_long_tag_name_2$ q $very_long_tag_name_2$")).toEqual([
      "string:$very_long_tag_name_2$ q $very_long_tag_name_2$",
    ]);
    expect(kinds("$1 + $2")).toEqual(["punct:$", "number:1", "punct:+", "punct:$", "number:2"]);
  });

  it("stays quiet inside an escape string and a long-tag string", () => {
    const at = (text: string) =>
      insideStringOrComment(tokenize(text.replace("|", "")), text.indexOf("|"));
    expect(at("SELECT E'it\\'s | x'")).toBe(true);
    expect(at("SELECT $t2$ in | side $t2$")).toBe(true);
    expect(at("SELECT $t2$ inside $t2$ |")).toBe(false);
  });
});
