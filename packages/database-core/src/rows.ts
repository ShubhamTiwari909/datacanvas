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
  ROWS_MAX_FILTERS,
  ROWS_MAX_FILTER_GROUPS,
  ROWS_MAX_FILTER_PATH,
  ROWS_MAX_FILTER_PATH_CHARS,
  ROWS_MAX_FILTER_VALUES,
  ROWS_MAX_FILTER_VALUE_CHARS,
  ROWS_MAX_OFFSET,
  ROWS_MAX_PAGE_SIZE,
  ROWS_MAX_RESPONSE_CHARS,
  ROWS_MAX_SORT_VALUE_CHARS,
  ROW_FILTER_OPS,
  type RowCell,
  type RowColumn,
  type RowColumnKind,
  type RowFilter,
  type RowFilterOp,
  type RowFilterShape,
  type RowOrder,
  type RowPage,
  type RowSecurityState,
  type RowSort,
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

/**
 * Where the next page starts. A keyset cursor holds the last row's key and, when the
 * page was sorted, the last row's value in the sort column (`value: null` is SQL NULL).
 */
export type RowsCursor =
  | { kind: "keyset"; values: string[]; sort?: { value: string | null } | undefined }
  | { kind: "offset"; offset: number };

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
    cursor.kind === "keyset"
      ? cursor.sort
        ? { k: cursor.values, s: [cursor.sort.value] }
        : { k: cursor.values }
      : { o: cursor.offset },
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
  const record = parsed as { k?: unknown; o?: unknown; s?: unknown };
  // The shapes: {k}, {k, s} (a sorted page) or {o}. Nothing else.
  const shape = [...keys].sort().join(",");
  if (shape !== "k" && shape !== "k,s" && shape !== "o") throw invalid();
  if (keys.includes("k")) {
    const values = record.k;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 32 ||
      !values.every((v) => typeof v === "string" && v.length <= 3000 && !v.includes("\u0000"))
    ) {
      throw invalid();
    }
    if (!keys.includes("s")) return { kind: "keyset", values: values as string[] };
    const sorted = record.s;
    const value = Array.isArray(sorted) && sorted.length === 1 ? sorted[0] : undefined;
    if (!(
      value === null ||
      (typeof value === "string" &&
        value.length <= ROWS_MAX_SORT_VALUE_CHARS &&
        !value.includes("\u0000"))
    )) {
      throw invalid();
    }
    return { kind: "keyset", values: values as string[], sort: { value } };
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
  sort: RowSort | null;
  filters: RowFilter[];
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
    sort: normalizeSort(options.sort),
    filters: normalizeFilters(options.filters),
  };
}

/** How many values each operator takes (the shared-types schema has the same table; a type test keeps them in step). */
export const FILTER_SHAPE: Record<RowFilterOp, RowFilterShape> = {
  eq: "one",
  neq: "one",
  gt: "one",
  gte: "one",
  lt: "one",
  lte: "one",
  contains: "one",
  starts_with: "one",
  ends_with: "one",
  not_contains: "one",
  matches: "one",
  is_empty: "none",
  in: "list",
  not_in: "list",
  between: "two",
  today: "none",
  last_7_days: "none",
  last_30_days: "none",
  this_month: "none",
  has_key: "one",
  json_contains: "one",
  json_path_eq: "path",
  array_contains: "list",
  array_overlaps: "list",
  array_is_empty: "none",
  is_null: "none",
  is_not_null: "none",
};

const FILTER_KEYS = ["column", "op", "value", "values", "path", "group"];

/** A text that can be a value: a string of bounded length with no NUL character (PostgreSQL cannot hold one). */
const isValueText = (v: unknown, max = ROWS_MAX_FILTER_VALUE_CHARS): v is string =>
  typeof v === "string" && v.length <= max && !v.includes("\u0000");

/** The shape of the conditions (not yet whether the columns allow them: see `checkRowsFilters`). */
function normalizeFilters(filters: readonly RowFilter[] | undefined): RowFilter[] {
  if (filters === undefined) return [];
  if (!Array.isArray(filters) || filters.length > ROWS_MAX_FILTERS) throw invalid();
  return filters.map((filter) => {
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) throw invalid();
    if (Object.keys(filter).some((key) => !FILTER_KEYS.includes(key))) throw invalid();
    const { column, op, value, values, path, group } = filter;
    if (typeof column !== "string" || column.length === 0 || column.length > 255) throw invalid();
    if (!(ROW_FILTER_OPS as readonly unknown[]).includes(op)) throw invalid();
    if (
      group !== undefined &&
      (!Number.isInteger(group) || group < 1 || group > ROWS_MAX_FILTER_GROUPS)
    ) {
      throw invalid();
    }
    const operator = op as RowFilterOp; // one of the list, checked above
    const out: RowFilter = { column, op: operator, ...(group !== undefined ? { group } : {}) };
    const shape = FILTER_SHAPE[operator];
    // Exactly the fields the operator takes, and no others.
    const given = {
      value: value !== undefined,
      values: values !== undefined,
      path: path !== undefined,
    };
    const wanted = {
      value: shape === "one" || shape === "path",
      values: shape === "list" || shape === "two",
      path: shape === "path",
    };
    if (
      given.value !== wanted.value ||
      given.values !== wanted.values ||
      given.path !== wanted.path
    ) {
      throw invalid();
    }
    if (wanted.value) {
      if (!isValueText(value)) throw invalid();
      out.value = value;
    }
    if (wanted.values) {
      if (
        !Array.isArray(values) ||
        values.length > ROWS_MAX_FILTER_VALUES ||
        (shape === "list" ? values.length === 0 : values.length !== 2) ||
        !values.every((v) => isValueText(v))
      ) {
        throw invalid();
      }
      out.values = [...values];
    }
    if (wanted.path) {
      if (
        !Array.isArray(path) ||
        path.length === 0 ||
        path.length > ROWS_MAX_FILTER_PATH ||
        !path.every((v) => isValueText(v, ROWS_MAX_FILTER_PATH_CHARS))
      ) {
        throw invalid();
      }
      out.path = [...path];
    }
    return out;
  });
}

const COMPARISONS: readonly RowFilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte"];
const NULLS: readonly RowFilterOp[] = ["is_null", "is_not_null"];
const LISTS: readonly RowFilterOp[] = ["in", "not_in", "between"];
const TEXT_ONLY: readonly RowFilterOp[] = [
  "contains",
  "starts_with",
  "ends_with",
  "not_contains",
  "matches",
  "is_empty",
];
const DATE_SHORTCUTS: readonly RowFilterOp[] = [
  "today",
  "last_7_days",
  "last_30_days",
  "this_month",
];

/** Is this a date or a timestamp, which the date shortcuts apply to? (From `format_type`, as the catalog prints it.) */
export const isTemporalType = (dataType: string): boolean => /^(date|timestamp)\b/.test(dataType);

/** The conditions a column of this kind (and type) can have. */
export function filterOpsFor(kind: RowColumnKind, dataType = ""): readonly RowFilterOp[] {
  if (kind === "text") return [...COMPARISONS, ...LISTS, ...TEXT_ONLY, ...NULLS];
  if (kind === "ordered") {
    return [
      ...COMPARISONS,
      ...LISTS,
      ...(isTemporalType(dataType) ? DATE_SHORTCUTS : []),
      ...NULLS,
    ];
  }
  if (kind === "json") return ["has_key", "json_contains", "json_path_eq", ...NULLS];
  if (kind === "array") return ["array_contains", "array_overlaps", "array_is_empty", ...NULLS];
  return NULLS;
}

/**
 * Check the conditions against the columns that were read. A column that is not one of them, a hidden column
 * (a condition on it would read it back one question at a time) or an operator the column's kind does not allow:
 * `invalid_request`, with a fixed message that never repeats a name or a value.
 */
export function checkRowsFilters(
  filters: readonly RowFilter[],
  columns: readonly RowColumn[],
): RowFilter[] {
  for (const filter of filters) {
    const column = columns.find((c) => c.name === filter.column);
    if (!column || column.masked || !filterOpsFor(column.kind, column.dataType).includes(filter.op))
      throw invalid();
  }
  return [...filters];
}

/** The shape of a sort request (not yet whether the table and column allow it: see `checkRowsSort`). */
function normalizeSort(sort: RowSort | null | undefined): RowSort | null {
  if (sort === undefined || sort === null) return null;
  if (
    typeof sort !== "object" ||
    Array.isArray(sort) ||
    typeof sort.column !== "string" ||
    sort.column.length === 0 ||
    sort.column.length > 255 ||
    (sort.direction !== "asc" && sort.direction !== "desc")
  ) {
    throw invalid();
  }
  return { column: sort.column, direction: sort.direction };
}

/** Can the rows of a table be sorted by this column? */
export function canSortRows(column: RowColumn, order: RowOrder): boolean {
  // A hidden column is refused: ordering by it (or paging past it) would read it back one comparison at a time.
  // A table without a key has no tie-breaker, so a page boundary could skip or repeat rows.
  return (
    !column.masked && (column.kind === "text" || column.kind === "ordered") && order.kind !== "none"
  );
}

/**
 * Check a sort against the columns that were read. A column that is not one of them
 * (a name that does not exist, or one of the columns left out beyond the first 100),
 * a hidden or unsortable column, or a table without a key: `invalid_request`
 * (a fixed message, no echo of the name).
 */
export function checkRowsSort(
  sort: RowSort | null,
  columns: readonly RowColumn[],
  order: RowOrder,
): RowSort | null {
  if (sort === null) return null;
  const column = columns.find((c) => c.name === sort.column);
  if (!column || !canSortRows(column, order)) throw invalid();
  return sort;
}

// -------------------------------------------------------------------- page ---

/** One row as read: a text or null per column (anything for a masked column), and the row's key values if the table has a key. */
export interface RawRow {
  cells: Array<string | null>;
  key: string[] | null;
  /** The row's value in the sort column, cut at `ROWS_MAX_SORT_VALUE_CHARS + 1` characters (null for SQL NULL); only when the page is sorted. */
  sortValue?: string | null | undefined;
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
  /** Row-level security as it applies to the connected role; `off` when not given. */
  rowSecurity?: RowSecurityState;
  /** The sort the rows were read with; null or absent for the key order. */
  sort?: RowSort | null;
  /** The conditions the rows were read with; absent for none. */
  filters?: readonly RowFilter[];
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
  const sort = input.sort ?? null;
  let nextCursor: string | null = null;
  let offsetCapped = false;
  let sortValueTooLong = false;
  if (more) {
    if (order.kind !== "none") {
      const last = included[included.length - 1];
      const key = last?.key;
      if (key) {
        if (sort === null) {
          nextCursor = encodeRowsCursor({ kind: "keyset", values: key });
        } else {
          const value = last.sortValue ?? null;
          const cursor =
            value === null || value.length <= ROWS_MAX_SORT_VALUE_CHARS
              ? encodeRowsCursor({ kind: "keyset", values: key, sort: { value } })
              : null;
          // A value too long to carry, or a cursor that would be refused for its size, ends the paging.
          if (cursor !== null && cursor.length <= ROWS_MAX_CURSOR_CHARS) nextCursor = cursor;
          else sortValueTooLong = true;
        }
      }
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
    rowSecurity: input.rowSecurity ?? "off",
    sort,
    filters: [...(input.filters ?? [])],
    sortValueTooLong,
  };
}
