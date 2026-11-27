/**
 * Reading a CSV file in the browser (`docs/advanced-data-workspace-plan.md`, section 9; decision 160). The file is
 * parsed HERE and the server only ever receives a matrix of text, so no parser of untrusted files runs there.
 *
 * Strict, never guessing: UTF-8 only (another encoding is refused, not decoded into the wrong characters), a byte
 * order mark is dropped, quotes and doubled quotes, line breaks inside quotes, `\r\n`, `\n` and `\r`, and the
 * delimiter is found (comma, semicolon, tab, pipe) or chosen. A row with a different number of fields from the
 * first, a quote that is not closed, a character after a closing quote, a NUL character, a cell over the limit,
 * too many rows or columns: each is a REFUSAL that names the row, never a repair. Pure functions, no React.
 */
import {
  IMPORT_MAX_CELL_CHARS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  MAX_BULK_ROWS,
  MAX_CHANGE_VALUE_CHARS,
} from "@datacanvas/database-core";

export type Delimiter = "," | ";" | "\t" | "|";
export const DELIMITERS: readonly Delimiter[] = [",", ";", "\t", "|"];

export type CsvRefusal =
  | "not_utf8"
  | "not_utf16"
  | "empty"
  | "nul"
  | "quote_open"
  | "after_quote"
  | "ragged"
  | "cell_too_long"
  | "too_many_rows"
  | "too_many_columns";

/** The sentence for each refusal, with the row it is about when there is one. Never a value of the file. */
export function refusalText(refusal: CsvRefusal, row?: number): string {
  const at = row === undefined ? "" : ` (row ${row})`;
  switch (refusal) {
    case "not_utf8":
      return "This file is not UTF-8 text. Save it as CSV UTF-8 and choose it again: another encoding would turn letters into the wrong characters, so it is not guessed.";
    case "not_utf16":
      return "This file is not UTF-16 text with a byte order mark. Choose another encoding, or save it as CSV UTF-8 and choose it again.";
    case "empty":
      return "The file is empty.";
    case "nul":
      return `The file holds a NUL character${at}, which a database cannot store in text.`;
    case "quote_open":
      return `A quoted value is never closed${at}. Check for a quote that is missing.`;
    case "after_quote":
      return `There is a character between the closing quote and the next separator${at}. A quote inside a quoted value is written twice.`;
    case "ragged":
      return `The row${at} has a different number of values from the first row. Fix the file, or choose the separator it uses.`;
    case "cell_too_long":
      return `A value${at} is longer than ${IMPORT_MAX_CELL_CHARS.toLocaleString("en-US")} characters.`;
    case "too_many_rows":
      return `The file has more than ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows. Split it and import the parts one at a time.`;
    case "too_many_columns":
      return `The file has more than ${IMPORT_MAX_COLUMNS} columns.`;
  }
}

export type Decoded = { ok: true; text: string } | { ok: false; refusal: "not_utf8" };

/** The text of a file, as UTF-8 with or without a byte order mark; anything else is refused. */
export function decodeUtf8(bytes: ArrayBuffer | Uint8Array): Decoded {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  } catch {
    return { ok: false, refusal: "not_utf8" };
  }
}

/**
 * The delimiter a file most likely uses: the one that appears the same (non-zero) number of times, outside quotes, on
 * every one of the first lines, the most often. A comma when none does.
 */
export function detectDelimiter(text: string): Delimiter {
  const counts = new Map<Delimiter, number[]>(DELIMITERS.map((d) => [d, []]));
  let lines = 0;
  let inQuotes = false;
  let current = new Map<Delimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let empty = true;
  const end = () => {
    if (!empty) {
      for (const d of DELIMITERS) counts.get(d)!.push(current.get(d)!);
      lines += 1;
    }
    current = new Map(DELIMITERS.map((d) => [d, 0]));
    empty = true;
  };
  for (let i = 0; i < text.length && lines < 20; i++) {
    const c = text[i]!;
    if (c === '"') {
      inQuotes = !inQuotes;
      empty = false;
    } else if (!inQuotes && (c === "\n" || c === "\r")) {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      end();
    } else if (!inQuotes && (DELIMITERS as readonly string[]).includes(c)) {
      current.set(c as Delimiter, current.get(c as Delimiter)! + 1);
      empty = false;
    } else {
      empty = false;
    }
  }
  if (lines < 20) end();
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const list = counts.get(d)!;
    const first = list[0] ?? 0;
    if (first > 0 && list.every((n) => n === first) && first > bestScore) {
      best = d;
      bestScore = first;
    }
  }
  return best;
}

export type Parsed =
  | { ok: true; rows: string[][]; delimiter: Delimiter; lines: number[] }
  | { ok: false; refusal: CsvRefusal; row?: number };

/**
 * Parse text into rows of fields. Row numbers in a refusal are the file's lines (the first line is 1; blank lines and
 * line breaks inside quotes count, so the number is where a text editor shows the row). A line with no characters is skipped, except in a file of one column, where
 * a blank line between rows is an empty value (skipping it would lose a row without a word); the fields of a row are
 * as written.
 */
export function parseCsv(
  text: string,
  delimiter: Delimiter,
  source: "file" | "clipboard" = "file",
): Parsed {
  const clipboard = source === "clipboard";
  const maxRows = clipboard ? MAX_BULK_ROWS : IMPORT_MAX_ROWS + 1;
  const maxCellChars = clipboard ? MAX_CHANGE_VALUE_CHARS : IMPORT_MAX_CELL_CHARS;
  if (text.includes("\u0000")) {
    // The first row with a NUL, so the person can find it.
    // Lines are counted as the parser counts them: \n, \r\n and a lone \r each end one.
    const nul = text.indexOf("\u0000");
    let row = 1;
    for (let i = 0; i < nul; i++) {
      if (text[i] === "\r" && text[i + 1] === "\n") continue;
      if (text[i] === "\n" || text[i] === "\r") row += 1;
    }
    return { ok: false, refusal: "nul", row };
  }
  if (clipboard ? text.length === 0 : text.trim() === "") return { ok: false, refusal: "empty" };
  const rows: string[][] = [];
  // The file's line each row starts on, parallel to `rows` (blank lines and line breaks inside quotes shift it).
  const lines: number[] = [];
  let startLine = 1;
  let width = -1;
  let row: string[] = [];
  let rowNumber = 1;
  let i = 0;
  const n = text.length;

  const pushRow = (): Parsed | null => {
    if (width === -1) {
      width = row.length;
      if (width > IMPORT_MAX_COLUMNS)
        return { ok: false, refusal: "too_many_columns", row: rowNumber };
    } else if (row.length !== width) {
      return { ok: false, refusal: "ragged", row: rowNumber };
    }
    rows.push(row);
    lines.push(startLine);
    // The header is one of the rows: the data may hold the most rows, plus the header.
    if (rows.length > maxRows) return { ok: false, refusal: "too_many_rows" };
    row = [];
    return null;
  };

  // Where the last character that is not a line break is: blank lines after it are the end of the file.
  let lastContent = n - 1;
  while (lastContent >= 0 && (text[lastContent] === "\n" || text[lastContent] === "\r"))
    lastContent -= 1;

  while (i < n) {
    // A line with no characters is not a row, unless the file has one column (then it is an empty value).
    if (text[i] === "\n" || text[i] === "\r") {
      if (text[i] === "\r" && text[i + 1] === "\n") i += 1;
      i += 1;
      if (clipboard || (width === 1 && i <= lastContent)) {
        startLine = rowNumber;
        row = [""];
        const refused = pushRow();
        if (refused) return refused;
      }
      rowNumber += 1;
      continue;
    }
    // One row: fields separated by the delimiter, up to a line break outside quotes or the end.
    startLine = rowNumber;
    for (;;) {
      let field: string;
      if (text[i] === '"') {
        // A quoted field: up to the closing quote; a doubled quote is a quote; line breaks stay.
        let value = "";
        i += 1;
        let closed = false;
        const startRow = rowNumber;
        while (i < n) {
          const q = text.indexOf('"', i);
          if (q === -1) break;
          value += text.slice(i, q);
          if (text[q + 1] === '"') {
            value += '"';
            i = q + 2;
          } else {
            i = q + 1;
            closed = true;
            break;
          }
        }
        if (!closed) return { ok: false, refusal: "quote_open", row: startRow };
        // \r\n, a lone \r and a lone \n are one line break each, as everywhere else in this parser.
        rowNumber += value.match(/\r\n|\r|\n/g)?.length ?? 0;
        const next = text[i];
        if (i < n && next !== delimiter && next !== "\n" && next !== "\r") {
          return { ok: false, refusal: "after_quote", row: startRow };
        }
        field = value;
      } else {
        // An unquoted field: up to the delimiter or the line break. A quote inside it is a quote.
        let j = i;
        while (j < n) {
          const c = text[j]!;
          if (c === delimiter || c === "\n" || c === "\r") break;
          j += 1;
        }
        field = text.slice(i, j);
        i = j;
      }
      if (field.length > maxCellChars) {
        return { ok: false, refusal: "cell_too_long", row: rowNumber };
      }
      row.push(field);
      if (i < n && text[i] === delimiter) {
        i += 1;
        // A delimiter at the very end of the text is an empty last field.
        if (i >= n) {
          row.push("");
          break;
        }
        continue;
      }
      break;
    }
    const refused = pushRow();
    if (refused) return refused;
    if (i < n) {
      if (text[i] === "\r" && text[i + 1] === "\n") i += 1;
      i += 1;
      rowNumber += 1;
    }
  }
  return { ok: true, rows, delimiter, lines };
}
