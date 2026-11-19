/**
 * The rows of a result as text a person can paste or save: CSV, TSV and JSON. Pure, so every
 * rule is tested without a browser. It writes exactly what the grid holds: the rows that were
 * read (not the ones left unread) with cells cut at the length the server keeps them.
 *
 * NULL is an empty field in CSV and TSV (a text format cannot tell it from an empty string)
 * and `null` in JSON. A value that a spreadsheet would run as a formula (it starts with `=`,
 * `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe, unless it is a plain
 * number: pasting a query result into a spreadsheet must never execute anything.
 */
import type { SqlResult } from "@datacanvas/shared-types";

type Columns = SqlResult["columns"];
type Rows = SqlResult["rows"];

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** The value as a spreadsheet would read it safely. */
export function defuse(value: string): string {
  return FORMULA_START.test(value) && !NUMBER.test(value) ? `'${value}` : value;
}

function field(value: string | null, delimiter: string): string {
  if (value === null) return "";
  const safe = defuse(value);
  const needsQuotes = safe.includes(delimiter) || /["\r\n]/.test(safe) || /^\s|\s$/.test(safe);
  return needsQuotes ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function delimited(columns: Columns, rows: Rows, delimiter: string): string {
  const lines = [columns.map((c) => field(c.name, delimiter)).join(delimiter)];
  for (const row of rows) lines.push(row.map((v) => field(v, delimiter)).join(delimiter));
  return lines.join("\r\n");
}

/** RFC 4180: comma-separated, `\r\n` between lines, quotes doubled. No byte order mark: `csvFile` adds one. */
export const toCsv = (columns: Columns, rows: Rows): string => delimited(columns, rows, ",");

/** The same with tabs, for pasting into a sheet. */
export const toTsv = (columns: Columns, rows: Rows): string => delimited(columns, rows, "\t");

/** A file for a spreadsheet: a byte order mark first, so a program that guesses the encoding guesses UTF-8. */
const BOM = String.fromCharCode(0xfeff);
export const csvFile = (columns: Columns, rows: Rows): string => `${BOM}${toCsv(columns, rows)}`;

/** An array of objects, one per row, keyed by column. A repeated column name gets `(2)`, `(3)`, ... */
export function toJson(columns: Columns, rows: Rows): string {
  const seen = new Map<string, number>();
  const keys = columns.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    return n === 1 ? c.name : `${c.name} (${n})`;
  });
  const objects = rows.map((row) => Object.fromEntries(keys.map((k, i) => [k, row[i] ?? null])));
  return JSON.stringify(objects, null, 2);
}

/** What the explain output of a statement looks like as one block: the lines of its only column. */
export const planText = (rows: Rows): string => rows.map((row) => row[0] ?? "").join("\n");
