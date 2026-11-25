import { describe, expect, it } from "vitest";
import { refusalText } from "./csv-parse";
import { decodeAs, decodeUtf16, decodeWindows1252, ENCODINGS, looksMisdecoded } from "./encodings";

const bytes = (...n: number[]) => new Uint8Array(n);
/** UTF-16 code units of a string, in the order asked, with the byte order mark first. */
const utf16 = (text: string, order: "le" | "be"): Uint8Array => {
  const out: number[] = order === "le" ? [0xff, 0xfe] : [0xfe, 0xff];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    const hi = unit >> 8;
    const lo = unit & 0xff;
    out.push(...(order === "le" ? [lo, hi] : [hi, lo]));
  }
  return new Uint8Array(out);
};

describe("decodeAs utf-8", () => {
  it("reads UTF-8 as decodeUtf8 does, never suspect", () => {
    expect(decodeAs(new TextEncoder().encode("a,é\n"), "utf-8")).toEqual({
      ok: true,
      text: "a,é\n",
      suspect: false,
    });
    expect(decodeAs(bytes(0xef, 0xbb, 0xbf, 0x61), "utf-8")).toEqual({
      ok: true,
      text: "a",
      suspect: false,
    });
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(decodeAs(bytes(0x61, 0xe9), "utf-8")).toEqual({ ok: false, refusal: "not_utf8" });
    expect(decodeAs(utf16("a", "le"), "utf-8")).toEqual({ ok: false, refusal: "not_utf8" });
  });

  it("takes an ArrayBuffer as well as bytes", () => {
    const buffer = new TextEncoder().encode("x,y").buffer as ArrayBuffer;
    expect(decodeAs(buffer, "utf-8")).toEqual({ ok: true, text: "x,y", suspect: false });
  });
});

describe("decodeUtf16", () => {
  const sample = "id;name\r\n1;Zoë 日本 😀\r\n";

  it("reads little and big endian by the byte order mark, and drops the mark", () => {
    expect(decodeUtf16(utf16(sample, "le"))).toEqual({ ok: true, text: sample, suspect: false });
    expect(decodeUtf16(utf16(sample, "be"))).toEqual({ ok: true, text: sample, suspect: false });
    expect(decodeAs(utf16(sample, "be"), "utf-16")).toEqual({
      ok: true,
      text: sample,
      suspect: false,
    });
  });

  it("keeps a second mark: only the first one is the byte order mark", () => {
    expect(decodeUtf16(bytes(0xff, 0xfe, 0xff, 0xfe, 0x61, 0x00))).toEqual({
      ok: true,
      text: "\uFEFFa",
      suspect: false,
    });
  });

  it("refuses a file with no byte order mark instead of guessing the order", () => {
    expect(decodeUtf16(bytes(0x61, 0x00, 0x62, 0x00))).toEqual({
      ok: false,
      refusal: "not_utf16",
    });
    expect(decodeUtf16(bytes())).toEqual({ ok: false, refusal: "not_utf16" });
    expect(decodeUtf16(bytes(0xff))).toEqual({ ok: false, refusal: "not_utf16" });
  });

  it("refuses malformed UTF-16: an odd number of bytes, a lone surrogate", () => {
    expect(decodeUtf16(bytes(0xff, 0xfe, 0x61, 0x00, 0x62))).toEqual({
      ok: false,
      refusal: "not_utf16",
    });
    expect(decodeUtf16(bytes(0xff, 0xfe, 0x00, 0xd8, 0x61, 0x00))).toEqual({
      ok: false,
      refusal: "not_utf16",
    });
    expect(decodeUtf16(bytes(0xfe, 0xff, 0xdc, 0x00))).toEqual({
      ok: false,
      refusal: "not_utf16",
    });
  });

  it("has a sentence for its refusal, with no value of the file", () => {
    expect(refusalText("not_utf16")).toMatch(/UTF-16/);
  });
});

describe("decodeWindows1252", () => {
  it("reads every byte, with the Windows-1252 letters in 0x80 to 0x9F", () => {
    // 0xE9 é, 0x80 €, 0x9C œ, 0x93 and 0x94 curly quotes.
    expect(decodeWindows1252(bytes(0x63, 0x61, 0x66, 0xe9, 0x2c, 0x80, 0x9c, 0x93, 0x94))).toEqual({
      ok: true,
      text: "café,€œ“”",
      suspect: false,
    });
    expect(decodeAs(bytes(0xe9), "windows-1252")).toEqual({ ok: true, text: "é", suspect: false });
  });

  it("never refuses, and marks text holding a C1 control character as suspect", () => {
    // 0x81, 0x8D, 0x8F, 0x90 and 0x9D have no letter in Windows-1252: they read as U+0081 and so on.
    for (const b of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) {
      const decoded = decodeWindows1252(bytes(0x61, b));
      expect(decoded.ok).toBe(true);
      expect(decoded.ok && decoded.suspect).toBe(true);
    }
  });

  it("reads every one of the 256 bytes without refusing", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    const decoded = decodeWindows1252(all);
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.text.length).toBe(256);
  });

  it("reads a UTF-16 file as something, so the warning and the preview are what tells", () => {
    expect(decodeWindows1252(new TextEncoder().encode("a,b")).ok).toBe(true);
  });
});

describe("looksMisdecoded", () => {
  it("is U+FFFD or U+0080 to U+009F, and nothing else", () => {
    expect(looksMisdecoded("plain é € 日本")).toBe(false);
    expect(looksMisdecoded("a\uFFFDb")).toBe(true);
    expect(looksMisdecoded("\u0080")).toBe(true);
    expect(looksMisdecoded("\u009F")).toBe(true);
    expect(looksMisdecoded("\u007F ")).toBe(false);
  });
});

describe("ENCODINGS", () => {
  it("is the three the dialog offers", () => {
    expect(ENCODINGS).toEqual(["utf-8", "utf-16", "windows-1252"]);
  });
});
