/**
 * What reaches Claude from the DATA level (`docs/mcp-server-plan.md`, sections 4 and 8; decision 169): pure functions that shape
 * a result and decide what may be said, so every rule here is a unit test and none depends on a database.
 *
 *  - **Hidden columns** (names that look sensitive) are never returned: the values of a result column with such a name are
 *    replaced by NULL, and a statement that NAMES such a column is refused before it runs. A name is only a hint (the role is
 *    the control, and `row_to_json(t)` could carry a column inside a value), which the dialog says.
 *  - **The database's own message is not passed on** unless it can only hold names: an error about a value (`invalid input
 *    syntax for type integer: "<a value of the row>"`) would be a way to read a hidden value through the text of an error.
 *  - **Size**: cells are cut at 500 characters and a result at about 100 KB, and both say so.
 */
import { isSensitiveColumnName, type RowPage } from "@datacanvas/database-core";
import type { SqlFailure, SqlResult } from "@datacanvas/shared-types";

/** The most characters of one cell Claude gets. */
export const CELL_CHARS = 500;
/** The most characters of the rows of one answer (about 100 KB). */
export const RESULT_CHARS = 100_000;

/** The text of a statement without its comments and its string literals (a word inside a string is not a column). */
function withoutQuotedText(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/'(?:[^']|'')*'/g, " ");
}

/**
 * The names in a statement that look sensitive, once each (at most five). A quoted identifier is read without its quotes.
 * Over-careful on purpose: a table called `password_resets` is caught too, and the answer says why.
 */
export function sensitiveNamesIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of withoutQuotedText(text).matchAll(
    /"((?:[^"]|"")*)"|([\p{L}_][\p{L}\p{N}_$]*)/gu,
  )) {
    const name = (match[1] ?? match[2] ?? "").replace(/""/g, '"');
    if (name !== "" && isSensitiveColumnName(name)) {
      found.add(name.slice(0, 60));
      if (found.size >= 5) break;
    }
  }
  return [...found];
}

/** The sentence for a statement the database refused: its own words only when they can only hold names. */
export function failureWords(failure: SqlFailure): string {
  const code = failure.code;
  if (code === "not_allowed" || code === "cancelled") return failure.message.slice(0, 400);
  // 42: syntax errors and unknown names ("column x does not exist", with a hint); 57014: a time limit; 54: a limit of the server.
  if (code.startsWith("42") || code === "57014" || code.startsWith("54"))
    return failure.message.slice(0, 400);
  return `The database refused the statement (SQLSTATE ${code}). Its message is not passed on because it can hold a value of the data.`;
}

export interface ShapedResult {
  columns: Array<{ name: string; type: string; hidden: boolean }>;
  rows: Array<Array<string | null>>;
  /** Rows the database had that are not here (the limit of rows, or of size). */
  truncated: boolean;
  /** Cells cut at `CELL_CHARS`. */
  cutCells: number;
  hiddenColumns: string[];
}

const cut = (value: string | null, counter: { n: number }): string | null => {
  if (value === null || value.length <= CELL_CHARS) return value;
  counter.n += 1;
  return value.slice(0, CELL_CHARS);
};

/** Fit a list of rows into `RESULT_CHARS`: the rows that fit, and whether some were left out. */
function fit(rows: Array<Array<string | null>>): {
  rows: Array<Array<string | null>>;
  left: boolean;
} {
  let size = 0;
  const kept: Array<Array<string | null>> = [];
  for (const row of rows) {
    size += JSON.stringify(row).length + 1;
    if (size > RESULT_CHARS && kept.length > 0) return { rows: kept, left: true };
    kept.push(row);
  }
  return { rows: kept, left: false };
}

/** The result of a statement, as Claude gets it: hidden columns NULL, cells and size bounded. */
export function shapeQueryResult(result: SqlResult): ShapedResult {
  const hidden = result.columns.map((c) => isSensitiveColumnName(c.name));
  const counter = { n: 0 };
  const rows = result.rows.map((row) =>
    row.map((value, i) => (hidden[i] ? null : cut(value, counter))),
  );
  const fitted = fit(rows);
  return {
    columns: result.columns.map((c, i) => ({
      name: c.name,
      type: c.dataType,
      hidden: hidden[i] === true,
    })),
    rows: fitted.rows,
    truncated: result.truncated || fitted.left,
    cutCells: counter.n + result.cutCells,
    hiddenColumns: result.columns.filter((_, i) => hidden[i]).map((c) => c.name),
  };
}

export interface ShapedPage extends ShapedResult {
  nextCursor: string | null;
  notes: string[];
}

/** A page of rows, as Claude gets it. The page reader already left hidden columns out (they are `masked`, every cell empty). */
export function shapePage(page: RowPage): ShapedPage {
  const hidden = page.columns.map((c) => c.masked);
  const counter = { n: 0 };
  const rows = page.rows.map((row) =>
    row.map((cell, i) => (hidden[i] ? null : cut(cell.value, counter))),
  );
  const fitted = fit(rows);
  const notes: string[] = [];
  const names = page.columns.filter((c) => c.masked).map((c) => c.name);
  if (names.length > 0) notes.push(`Hidden columns, never returned: ${names.join(", ")}.`);
  if (page.hiddenColumns > 0)
    notes.push(`${page.hiddenColumns} more columns of the table are not shown.`);
  if (page.cutBySize || fitted.left)
    notes.push("The page was shortened to fit the size limit: ask for a smaller page.");
  if (page.rowSecurity === "applies")
    notes.push("Row-level security applies to this role: some rows may not be returned.");
  if (page.offsetCapped) notes.push("This table has no key and more rows than can be paged to.");
  const nextCursor = fitted.left ? null : page.nextCursor;
  return {
    columns: page.columns.map((c) => ({ name: c.name, type: c.dataType, hidden: c.masked })),
    rows: fitted.rows,
    truncated: fitted.left || page.nextCursor !== null,
    cutCells: counter.n,
    hiddenColumns: names,
    nextCursor,
    notes,
  };
}
