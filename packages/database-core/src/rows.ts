/**
 * Pure helpers for reading table rows, shared by every adapter (the real one
 * and the mock) so they cannot drift apart: which columns are masked, the paging
 * cursor, validation of the options, and the assembly of a page with its limits.
 *
 * Nothing here talks to a database. Rows are never logged or stored by this
 * code; it only shapes values that its caller already holds in memory.
 */
import { DatabaseError } from "./errors.js";
import {
  ROWS_CELL_CHARS,
  ROWS_MAX_CURSOR_CHARS,
  ROWS_MAX_OFFSET,
  ROWS_MAX_PAGE_SIZE,
  ROWS_MAX_RESPONSE_CHARS,
  type RowCell,
  type RowColumn,
  type RowOrder,
  type RowPage,
  type RowsOptions,
} from "./models.js";
import { safeSlice } from "./objects.js";

// ----------------------------------------------------------------- masking ---

/** Parts of a name (letters and digits only, lowercased, separators removed) that mark a column as sensitive. */
const SENSITIVE_PARTS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "accesskey",
  "credential",
];
/** Whole words that mark a column as sensitive (too short to match inside other words). */
const SENSITIVE_WORDS = new Set(["salt", "pwd"]);

/**
 * Does this column NAME look sensitive (a password, a token, a key)? Names are
 * only a hint: `notes` can hold a password and `token_count` is harmless, so
 * this is a convenience that keeps likely secrets out of the default view, not
 * a security control. A column that is masked can be revealed by name.
 */
export function isSensitiveColumnName(name: string): boolean {
  // "apiKey" and "api_key" and "API-KEY" all become "apikey".
  const compact = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (SENSITIVE_PARTS.some((part) => compact.includes(part))) return true;
  const words = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  return words.some((word) => SENSITIVE_WORDS.has(word));
}

// ------------------------------------------------------------------ cursor ---

export type RowsCursor = { kind: "keyset"; values: string[] } | { kind: "offset"; offset: number };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]!;
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    value = (value << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

export function encodeRowsCursor(cursor: RowsCursor): string {
  const json = JSON.stringify(
    cursor.kind === "keyset" ? { k: cursor.values } : { o: cursor.offset },
  );
  // Escape everything outside ASCII (\uXXXX), so the cursor is plain ASCII and needs no
  // UTF-8 handling; JSON.parse reads the escapes back, including surrogate pairs.
  const ascii = json.replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return toBase64Url(Uint8Array.from(ascii, (c) => c.charCodeAt(0)));
}

const invalid = (cause?: unknown): DatabaseError => new DatabaseError("invalid_request", { cause });

/**
 * Read a cursor from the outside. It is UNTRUSTED: it can only be one of the two
 * shapes this module writes, with bounded length and values, and it is only ever
 * used as bound parameters, so a forged cursor can at worst change where the
 * page starts. A cursor that is not valid is refused with `invalid_request`
 * (a fixed message that never repeats it).
 */
export function decodeRowsCursor(text: string): RowsCursor {
  if (text.length === 0 || text.length > ROWS_MAX_CURSOR_CHARS) throw invalid();
  const bytes = fromBase64Url(text);
  if (bytes === null) throw invalid();
  let parsed: unknown;
  try {
    if (bytes.some((b) => b > 127)) throw invalid();
    parsed = JSON.parse(String.fromCharCode(...bytes));
  } catch (error) {
    throw invalid(error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid();
  const keys = Object.keys(parsed);
  if (keys.length !== 1) throw invalid();
  const record = parsed as { k?: unknown; o?: unknown };
  if (keys[0] === "k") {
    const values = record.k;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 32 ||
      !values.every((v) => typeof v === "string" && v.length <= 3000 && !v.includes("\u0000"))
    ) {
      throw invalid();
    }
    return { kind: "keyset", values: values as string[] };
  }
  if (keys[0] === "o") {
    const offset = record.o;
    if (
      typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > ROWS_MAX_OFFSET
    ) {
      throw invalid();
    }
    return { kind: "offset", offset };
  }
  throw invalid();
}

// ----------------------------------------------------------------- options ---

export interface NormalizedRowsOptions {
  pageSize: number;
  cursor: RowsCursor | null;
  reveal: ReadonlySet<string>;
}

/** Validate what the caller asked for. @throws DatabaseError `invalid_request` */
export function normalizeRowsOptions(options: RowsOptions): NormalizedRowsOptions {
  const { pageSize, cursor, revealColumns } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > ROWS_MAX_PAGE_SIZE) throw invalid();
  if (cursor !== null && typeof cursor !== "string") throw invalid();
  if (
    !Array.isArray(revealColumns) ||
    revealColumns.length > 1000 ||
    !revealColumns.every((name) => typeof name === "string" && name.length <= 255)
  ) {
    throw invalid();
  }
  return {
    pageSize,
    cursor: cursor === null ? null : decodeRowsCursor(cursor),
    reveal: new Set(revealColumns),
  };
}

// -------------------------------------------------------------------- page ---

/** One row as read: a text or null per column (anything for a masked column), and the row's key values if the table has a key. */
export interface RawRow {
  cells: Array<string | null>;
  key: string[] | null;
}

export interface BuildRowPageInput {
  columns: RowColumn[];
  hiddenColumns: number;
  order: RowOrder;
  /**
   * The rows read: at most `pageSize + 1`. The extra row, if present, only says
   * there is more to read and is not part of the page.
   */
  rawRows: RawRow[];
  pageSize: number;
  /** Where an unordered page starts (0 for the first page). Ignored when the table has a key. */
  offset: number;
}

/** Cut one raw value to the cell limit (the database already cut it; this keeps every adapter to the same limit). */
function toCell(raw: string | null): RowCell {
  if (raw === null) return { value: null, truncated: false };
  return raw.length > ROWS_CELL_CHARS
    ? { value: safeSlice(raw, ROWS_CELL_CHARS), truncated: true }
    : { value: raw, truncated: false };
}

/**
 * Assemble the page: apply the cell limit, mask the masked columns, stop before
 * the response gets too big, and work out the cursor for the next page.
 */
export function buildRowPage(input: BuildRowPageInput): RowPage {
  const { columns, order, rawRows, pageSize, offset } = input;
  const candidates = rawRows.slice(0, pageSize);
  const rows: RowCell[][] = [];
  const included: RawRow[] = [];
  let size = 0;
  let cutBySize = false;

  for (const raw of candidates) {
    const cells = columns.map((column, i) =>
      column.masked ? { value: null, truncated: false } : toCell(raw.cells[i] ?? null),
    );
    const rowSize = cells.reduce((sum, cell) => sum + (cell.value?.length ?? 0), 0);
    // Always keep at least one row, so a page is never empty because of its size.
    if (rows.length > 0 && size + rowSize > ROWS_MAX_RESPONSE_CHARS) {
      cutBySize = true;
      break;
    }
    size += rowSize;
    rows.push(cells);
    included.push(raw);
  }

  const more = rawRows.length > pageSize || cutBySize;
  let nextCursor: string | null = null;
  let offsetCapped = false;
  if (more) {
    if (order.kind !== "none") {
      const key = included[included.length - 1]?.key;
      if (key) nextCursor = encodeRowsCursor({ kind: "keyset", values: key });
    } else {
      const next = offset + included.length;
      if (next >= ROWS_MAX_OFFSET) offsetCapped = true;
      else nextCursor = encodeRowsCursor({ kind: "offset", offset: next });
    }
  }

  return {
    columns,
    rows,
    nextCursor,
    order,
    hiddenColumns: input.hiddenColumns,
    cutBySize,
    offsetCapped,
  };
}
