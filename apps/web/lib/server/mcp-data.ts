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

/**
 * The text of a statement with its comments, string literals and dollar-quoted text taken out (a word inside a string is not a
 * column), read in ONE pass as PostgreSQL reads it: a string that holds a comment opener (`'/*'`) is a string, a comment that
 * holds a quote is a comment, block comments nest, `E'..'` strings take a backslash. Quoted identifiers are kept.
 */
function withoutQuotedText(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && text[i] !== "\n") i += 1;
      out += " ";
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      out += " ";
    } else if (c === "'") {
      const escapes = /[eE]/.test(text[i - 1] ?? "") && !/[\p{L}\p{N}_$]/u.test(text[i - 2] ?? " ");
      i += 1;
      while (i < n) {
        if (escapes && text[i] === "\\") i += 2;
        else if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      out += " ";
    } else if (c === "$") {
      const tag = /^\$([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/.exec(text.slice(i, i + 80));
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? n : end + tag[0].length;
        out += " ";
      } else {
        out += c;
        i += 1;
      }
    } else if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '"' && text[j + 1] === '"') j += 2;
        else if (text[j] === '"') break;
        else j += 1;
      }
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const NAME_TOKEN = /"((?:[^"]|"")*)"|([\p{L}_][\p{L}\p{N}_$]*)/gu;

/** The identifiers of a statement (quoted ones without their quotes), outside comments and strings. */
function identifiersIn(text: string): string[] {
  const names: string[] = [];
  for (const match of withoutQuotedText(text).matchAll(NAME_TOKEN)) {
    names.push((match[1] ?? match[2] ?? "").replace(/""/g, '"'));
  }
  return names;
}

/**
 * The names in a statement that look sensitive, once each (at most five). A quoted identifier is read without its quotes.
 * Over-careful on purpose: a table called `password_resets` is caught too, and the answer says why.
 */
export function sensitiveNamesIn(text: string): string[] {
  const found = new Set<string>();
  for (const name of identifiersIn(text)) {
    if (name !== "" && isSensitiveColumnName(name)) {
      found.add(name.slice(0, 60));
      if (found.size >= 5) break;
    }
  }
  return [...found];
}

/**
 * Names that Claude's statements may not use even though the transaction is read-only: the statistics catalogs (they hold
 * sampled VALUES of every column, hidden ones too), the view of other sessions' statements (their text holds values), and
 * functions with an effect outside the data (a notification, an advisory lock, another database, a large object, a server
 * setting or another session).
 */
const NOT_FOR_CLAUDE =
  /^(pg_stats|pg_statistic|pg_stats_ext|pg_stats_ext_exprs|pg_statistic_ext_data|pg_stat_activity|pg_stat_statements|pg_notify|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_stat_reset\w*|pg_advisory\w*|pg_try_advisory\w*|dblink\w*|lo_\w+|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|set_config)$/i;

/** The names in a statement that Claude may not use (once each, at most five). */
export function forbiddenNamesIn(text: string): string[] {
  const found = new Set<string>();
  for (const name of identifiersIn(text)) {
    if (NOT_FOR_CLAUDE.test(name)) {
      found.add(name.toLowerCase());
      if (found.size >= 5) break;
    }
  }
  return [...found];
}

/** The double-quoted parts of a database message. */
const quotedParts = (message: string): string[] =>
  [...message.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

/**
 * The sentence for a statement the database refused. Its own words are passed on only when they cannot carry a value: our own
 * refusals, a time or size limit, and an error about names (class 42) in which EVERY quoted part is text of the statement
 * itself. (`SELECT (t::text)::regclass FROM t` says `relation "<the row>" does not exist`: a value, not a name of the statement.)
 */
export function failureWords(failure: SqlFailure, statement = ""): string {
  const code = failure.code;
  if (code === "not_allowed" || code === "cancelled") return failure.message.slice(0, 400);
  if (code === "57014" || code.startsWith("54")) return failure.message.slice(0, 400);
  if (code.startsWith("42")) {
    const text = statement.toLowerCase();
    if (quotedParts(failure.message).every((part) => text.includes(part.toLowerCase())))
      return failure.message.slice(0, 400);
    return `The database refused the statement (SQLSTATE ${code}). Its message is not passed on because it quotes text that is not in your statement, which can be a value of the data.`;
  }
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
