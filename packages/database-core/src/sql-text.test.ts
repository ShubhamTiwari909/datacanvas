import { describe, expect, it } from "vitest";
import { quoteIdentifier, quoteQualified, quoteString } from "./sql-text.js";

describe("quoteIdentifier", () => {
  it("wraps a plain name in double quotes", () => {
    expect(quoteIdentifier("users")).toBe('"users"');
  });

  it("doubles every double quote, so a name cannot end the identifier early", () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(quoteIdentifier('"; DROP TABLE x; --')).toBe('"""; DROP TABLE x; --"');
    expect(quoteIdentifier('""')).toBe('""""""');
  });

  it("keeps spaces, capitals, Unicode, emoji and SQL words as they are", () => {
    for (const name of ["Unit Price", "select", "naïve_日本", "🙂", "a.b", "a;b", "--", "", "$1"]) {
      expect(quoteIdentifier(name)).toBe(`"${name}"`);
    }
  });

  it("leaves a backslash and a NUL-free percent sign alone (they are not special in identifiers)", () => {
    expect(quoteIdentifier("a\\b%c")).toBe('"a\\b%c"');
  });
});

describe("quoteQualified", () => {
  it("quotes both parts separately", () => {
    expect(quoteQualified("public", "users")).toBe('"public"."users"');
    expect(quoteQualified("my schema", 'we"ird')).toBe('"my schema"."we""ird"');
  });

  it("does not let a dot inside a name split it", () => {
    expect(quoteQualified("a.b", "c.d")).toBe('"a.b"."c.d"');
  });
});

describe("quoteString", () => {
  it("doubles single quotes and keeps plain text plain", () => {
    expect(quoteString("it's")).toBe("'it''s'");
    expect(quoteString("")).toBe("''");
    expect(quoteString("a; DROP TABLE x; --")).toBe("'a; DROP TABLE x; --'");
  });

  it("writes a string with a backslash as an escape string with the backslashes doubled", () => {
    expect(quoteString("a\\b")).toBe("E'a\\\\b'");
    expect(quoteString("it's \\")).toBe("E'it''s \\\\'");
  });

  it("keeps line breaks and other characters as they are, and refuses NUL", () => {
    expect(quoteString("a\nbé\u{1F600}")).toBe("'a\nbé\u{1F600}'");
    expect(() => quoteString("a\0b")).toThrow(RangeError);
  });
});
