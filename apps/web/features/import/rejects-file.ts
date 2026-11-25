/**
 * The rejects file (`docs/write-side-v2-plan.md`, section 4.3, item 3): the rows left out of an import, made in the
 * browser so the person can fix them and import them again. The server never sees it. Pure functions, no React.
 *
 *  - The file's own header and delimiter, the rejected rows as the file held them, and a last column
 *    `datacanvas_reject_v1` with the reason: a fixed sentence and names of the structure from the report, never a
 *    value.
 *  - Always UTF-8 text with a byte order mark, whatever encoding the file was read in.
 *  - Every field goes through the formula rule of the SQL tab's export (`defuse`), made REVERSIBLE: a value gets
 *    one more apostrophe when it is zero or more apostrophes followed by what `defuse` defuses (`=x` is written
 *    `'=x`, and `'=x` is written `''=x`). Reading the file back, after the person ACCEPTS the dialog's offer, drops
 *    the reserved column and removes exactly one such apostrophe, which gives every value back.
 */
import { defuse } from "@/features/sql/export";
import type { Delimiter } from "./csv-parse";
import type { Reject, RejectReason } from "./leave-out";

/** The reserved name of the last column, with a version so the rule can change. */
export const REJECTS_COLUMN = "datacanvas_reject_v1";

const BOM = "\uFEFF";

/** Whether the export's rule would put an apostrophe in front of this value. */
const defused = (value: string): boolean => defuse(value) !== value;

/** The value with its leading apostrophes taken off. */
const afterApostrophes = (value: string): string => value.replace(/^'+/, "");

/**
 * The value as the rejects file writes it: one more apostrophe when, past its leading apostrophes, it is what the
 * export's rule defuses. What a spreadsheet would run always starts with an apostrophe here.
 */
export function defuseReversible(value: string): string {
  return defused(afterApostrophes(value)) ? `'${value}` : value;
}

/** The value as it was before `defuseReversible`: exactly one apostrophe off, only where that rule put one. */
export function restoreDefused(value: string): string {
  return value.startsWith("'") && defused(afterApostrophes(value)) ? value.slice(1) : value;
}

/** The reason of a row in fixed words, with only names of the structure. `types` gives a column's type, if known. */
export function reasonText(reason: RejectReason, types?: ReadonlyMap<string, string>): string {
  const { rule, column, constraint } = reason;
  switch (rule) {
    case "unique_in_request":
    case "unique_existing":
      return "unique key";
    case "not_null":
      return column === null ? "NOT NULL" : `NOT NULL of ${column}`;
    case "type": {
      const type = column === null ? undefined : types?.get(column);
      return `does not fit ${type ?? column ?? "its column"}`;
    }
    case "check":
      return constraint !== null
        ? `check ${constraint}`
        : column !== null
          ? `check of ${column}`
          : "check";
    case "foreign_key":
      return constraint === null ? "foreign key" : `foreign key ${constraint}`;
    case "no_effects":
    case "rejected":
      return "rejected";
  }
}

/** The reasons of one row as one field: each different sentence once, in the order found. */
export function reasonsText(
  reasons: readonly RejectReason[],
  types?: ReadonlyMap<string, string>,
): string {
  return [...new Set(reasons.map((r) => reasonText(r, types)))].join("; ");
}

/** One field: defused, then quoted when it holds the delimiter, a quote, a line break, or white space at an end. */
function field(value: string, delimiter: Delimiter): string {
  const safe = defuseReversible(value);
  const quote = safe.includes(delimiter) || /["\r\n]/.test(safe) || /^\s|\s$/.test(safe);
  return quote ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface RejectsFileInput {
  /** The file's header, or null when its first row was data (the columns are then named `column_1`, ...). */
  header: readonly string[] | null;
  rejects: readonly Reject[];
  delimiter: Delimiter;
  /** The type of each column of the table, by name, for "does not fit integer". */
  types?: ReadonlyMap<string, string>;
}

/**
 * The text of the rejects file: a byte order mark, the header with the reserved column, then one line per reject in
 * the order of the file, `\r\n` between lines. Saved as a Blob of this string, it is UTF-8.
 */
export function buildRejectsCsv(input: RejectsFileInput): string {
  const width = input.header?.length ?? input.rejects[0]?.row.length ?? 0;
  const header = input.header ?? Array.from({ length: width }, (_, i) => `column_${i + 1}`);
  const line = (fields: readonly string[]) =>
    fields.map((f) => field(f, input.delimiter)).join(input.delimiter);
  const lines = [line([...header, REJECTS_COLUMN])];
  for (const reject of [...input.rejects].sort((a, b) => a.line - b.line)) {
    lines.push(line([...reject.row, reasonsText(reject.reasons, input.types)]));
  }
  return BOM + lines.join("\r\n") + "\r\n";
}

/** Whether a file's first row looks like a rejects file's header, for the dialog to OFFER restoring (never silently). */
export function isRejectsHeader(header: readonly string[] | undefined): boolean {
  return header !== undefined && header.length >= 2 && header[header.length - 1] === REJECTS_COLUMN;
}

/**
 * The rows of a rejects file as they were before it was written, once the person has accepted: the reserved last
 * column dropped and every field restored (the header too). Rows of a file that is not one are returned unchanged.
 */
export function restoreRejectsRows(rows: readonly (readonly string[])[]): string[][] {
  if (!isRejectsHeader(rows[0])) return rows.map((row) => [...row]);
  return rows.map((row) => row.slice(0, -1).map(restoreDefused));
}
