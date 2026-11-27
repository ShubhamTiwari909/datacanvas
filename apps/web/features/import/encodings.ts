/**
 * Reading a file in an encoding the person chooses (`docs/write-side-v2-plan.md`, section 4.4). UTF-8 stays the
 * default and is read by `decodeUtf8`; when it is refused, the dialog offers Windows-1252 (which is what a browser's
 * decoder means by Latin-1 and `iso-8859-1`) and UTF-16. Pure functions, no React.
 *
 *  - UTF-8 and UTF-16 are read with `fatal: true`: a malformed file is REFUSED, never repaired.
 *  - UTF-16 needs its byte order mark, which picks little or big endian; without one the order would be a guess,
 *    so it is refused.
 *  - Windows-1252 maps every byte to a character, so it never refuses: the text is marked `suspect` when it holds
 *    U+FFFD or a control character U+0080 to U+009F, the usual sign of a wrong choice, for the dialog to warn.
 *
 * The size limits are the dialog's, on the bytes of the file, before decoding: nothing here counts characters.
 */
import { decodeUtf8 } from "./csv-parse";

export type Encoding = "utf-8" | "utf-16" | "windows-1252";
export const ENCODINGS: readonly Encoding[] = ["utf-8", "utf-16", "windows-1252"];

export type DecodedAs =
  { ok: true; text: string; suspect: boolean } | { ok: false; refusal: "not_utf8" | "not_utf16" };

/** U+FFFD, or a C1 control character: what text read in the wrong single-byte encoding tends to hold. */
const SUSPECT = /[\uFFFD\u0080-\u009F]/;

/** Whether decoded text holds a sign that the encoding chosen was the wrong one. */
export function looksMisdecoded(text: string): boolean {
  return SUSPECT.test(text);
}

const view = (bytes: ArrayBuffer | Uint8Array): Uint8Array =>
  bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

/** UTF-16 by its byte order mark (FF FE little endian, FE FF big endian), the mark dropped; anything else is refused. */
export function decodeUtf16(bytes: ArrayBuffer | Uint8Array): DecodedAs {
  const all = view(bytes);
  const order =
    all[0] === 0xff && all[1] === 0xfe
      ? "utf-16le"
      : all[0] === 0xfe && all[1] === 0xff
        ? "utf-16be"
        : null;
  if (order === null) return { ok: false, refusal: "not_utf16" };
  try {
    const text = new TextDecoder(order, { fatal: true, ignoreBOM: true }).decode(all.subarray(2));
    return { ok: true, text, suspect: false };
  } catch {
    return { ok: false, refusal: "not_utf16" };
  }
}

/**
 * Bytes 0x80 to 0x9F in Windows-1252, as the WHATWG Encoding standard reads them (five have no letter and stay
 * control characters). A browser's decoder already gives these; some runtimes (Node 22) read the label as plain
 * ISO-8859-1 and give U+0080 to U+009F, so the decoded text is passed through this table, which changes nothing
 * where the decoder was right.
 */
const C1_AS_WINDOWS_1252 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
].map((code) => String.fromCharCode(code));

/** Windows-1252 (Latin-1): every byte is a character, so it never refuses; `suspect` says when to warn. */
export function decodeWindows1252(bytes: ArrayBuffer | Uint8Array): DecodedAs {
  const text = new TextDecoder("windows-1252")
    .decode(view(bytes))
    .replace(/[\u0080-\u009F]/g, (c) => C1_AS_WINDOWS_1252[c.charCodeAt(0) - 0x80]!);
  return { ok: true, text, suspect: looksMisdecoded(text) };
}

/** The text of a file read in the encoding chosen. */
export function decodeAs(bytes: ArrayBuffer | Uint8Array, encoding: Encoding): DecodedAs {
  switch (encoding) {
    case "utf-8": {
      const decoded = decodeUtf8(bytes);
      return decoded.ok ? { ok: true, text: decoded.text, suspect: false } : decoded;
    }
    case "utf-16":
      return decodeUtf16(bytes);
    case "windows-1252":
      return decodeWindows1252(bytes);
  }
}
