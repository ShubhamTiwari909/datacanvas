/**
 * Running ONE statement the person typed (1.6.0, the SQL Workspace; see
 * `docs/sql-workspace-plan.md` and decision 141).
 *
 * This is a capability apart from `DatabaseAdapter`, as writes are: an adapter
 * that implements `SqlRunnerAdapter` can run text, and only the server's
 * `sql-service` may call it (a rule in tests/architecture.test.ts). It is
 * READ ONLY by construction: the adapter runs the statement in a read-only
 * transaction on a connection of its own, one statement at a time.
 */

// ----------------------------------------------------------------- limits ---

export const SQL_LIMITS = {
  /** Characters of one statement. */
  maxTextChars: 200_000,
  /** Rows returned unless the person chooses another number, and the most they can choose. */
  defaultMaxRows: 1000,
  maxMaxRows: 10_000,
  /** Statement timeout unless chosen otherwise, and the most that can be chosen. */
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 300_000,
  /** Characters kept of one cell (the rest is cut, and the cell says so in the grid). */
  maxCellChars: 2000,
  /** Bytes read from the server for one result, counted before cells are cut: past it the rest is not read. */
  maxResultBytes: 64 * 1024 * 1024,
  /** Lock wait: a query never queues behind a lock for long. */
  lockTimeoutMs: 3000,
} as const;

// ------------------------------------------------------------ the capability ---

/** The part of an `AbortSignal` the runner needs (this package has no DOM or Node types). */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface SqlRunRequest {
  /** One statement. */
  text: string;
  maxRows: number;
  timeoutMs: number;
  /** Aborting it cancels the statement in the database. */
  signal?: AbortLike;
}

export interface SqlResultColumn {
  name: string;
  /** As the database prints the type (`format_type`), e.g. "numeric(10,2)". */
  dataType: string;
}

export interface SqlRunResult {
  columns: SqlResultColumn[];
  /** Every value as text; `null` is SQL NULL. */
  rows: (string | null)[][];
  /** More rows were available than `maxRows`; the rest were not read. */
  truncated: boolean;
  /** The command tag, e.g. "SELECT", "SHOW", "EXPLAIN". */
  command: string;
  /** Cells cut to `maxCellChars`. */
  cutCells: number;
  elapsedMs: number;
}

export interface SqlRunnerAdapter {
  /**
   * Run the statement read-only. Resolves with the result.
   * @throws SqlStatementError when the database rejected or stopped the statement;
   *   DatabaseError for anything about the connection.
   */
  runStatement(request: SqlRunRequest): Promise<SqlRunResult>;
}

export function isSqlRunnerAdapter(value: unknown): value is SqlRunnerAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { runStatement?: unknown }).runStatement === "function"
  );
}

/**
 * The database refused or stopped the statement the person typed. Unlike a
 * `DatabaseError` its message is the database's own sentence: a SQL tool is of
 * no use without it, and it is about the person's own text. It never holds
 * connection details (the adapter takes it from the server's error message only
 * after the connection was made).
 */
export class SqlStatementError extends Error {
  /** The SQLSTATE (e.g. "42P01"), or "cancelled" or "not_allowed" for ours. */
  readonly code: string;
  /** 1-based character position in the person's text, when the database gave one. */
  readonly position: number | null;

  constructor(code: string, message: string, position: number | null = null) {
    super(message);
    this.name = "SqlStatementError";
    this.code = code;
    this.position = position;
  }
}

// ------------------------------------------------------- what may be typed ---

/** What the first word of a statement may be. The database enforces read-only; this makes the refusal plain. */
export const ALLOWED_FIRST_WORDS = [
  "select",
  "with",
  "values",
  "table",
  "explain",
  "show",
] as const;

/** Every control character but the tab and the line feed. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export const NOT_ALLOWED_MESSAGE =
  "Only SELECT, WITH, VALUES, TABLE, EXPLAIN and SHOW statements can be run here. The SQL view is read-only.";

export type StatementCheck = { ok: true } | { ok: false; message: string };

/**
 * The first word of a statement, lower case, after whitespace, comments (`--` and the
 * nested block comments PostgreSQL has) and opening parentheses; null when there is none
 * or a block comment is never closed.
 */
export function firstKeyword(text: string): string | null {
  let i = 0;
  const n = text.length;
  const skip = (): boolean => {
    for (;;) {
      while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n")) i++;
      if (text.startsWith("--", i)) {
        while (i < n && text[i] !== "\n") i++;
      } else if (text.startsWith("/*", i)) {
        let depth = 1;
        i += 2;
        while (i < n && depth > 0) {
          if (text.startsWith("/*", i)) {
            depth++;
            i += 2;
          } else if (text.startsWith("*/", i)) {
            depth--;
            i += 2;
          } else i++;
        }
        if (depth > 0) return false;
      } else return true;
    }
  };
  for (;;) {
    if (!skip()) return null;
    if (text[i] === "(") i++;
    else break;
  }
  const match = /^[A-Za-z]+/.exec(text.slice(i, i + 20));
  return match ? match[0].toLowerCase() : null;
}

const QUERY_WORDS = ["select", "with", "values", "table"];

export const EXPLAIN_NOT_ALLOWED_MESSAGE =
  "EXPLAIN can explain a SELECT, WITH, VALUES or TABLE statement here, and one that does not contain the word INTO.";

/**
 * EXPLAIN ANALYZE RUNS what it explains, and PostgreSQL does not stop `EXPLAIN ANALYZE CREATE
 * TABLE ... AS ...`, `CREATE MATERIALIZED VIEW` or `SELECT ... INTO` in a read-only transaction:
 * they create the table (found in the review of the SQL runner and confirmed on a real server).
 * So what follows EXPLAIN and its options must be a plain query, and the word INTO (which makes
 * a SELECT create a table) may not appear in it. A string that holds the word is refused too:
 * the cost of not having to read strings the way PostgreSQL does.
 */
function checkExplained(text: string): StatementCheck {
  // After EXPLAIN: options in parentheses, or the words ANALYZE and VERBOSE, then the statement.
  const afterWord = text.search(/explain/i);
  let rest = text.slice(afterWord + "explain".length);
  for (;;) {
    const trimmed = rest.replace(/^(?:[ \t\n]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
    if (trimmed.startsWith("(")) {
      const close = trimmed.indexOf(")");
      if (close < 0) return { ok: false, message: EXPLAIN_NOT_ALLOWED_MESSAGE };
      // Options hold no parentheses of their own, so the first `)` ends them.
      rest = trimmed.slice(close + 1);
      continue;
    }
    const keyword = /^(analyze|analyse|verbose)\b/i.exec(trimmed);
    if (keyword) {
      rest = trimmed.slice(keyword[0].length);
      continue;
    }
    rest = trimmed;
    break;
  }
  const inner = firstKeyword(rest);
  if (inner === null || !QUERY_WORDS.includes(inner) || /\binto\b/i.test(rest)) {
    return { ok: false, message: EXPLAIN_NOT_ALLOWED_MESSAGE };
  }
  return { ok: true };
}

/**
 * NOT what keeps the database safe (a read-only transaction does), this keeps out what a
 * read-only transaction does not stop (`DO`, `COPY ... PROGRAM`, `CALL`, `SET`, `BEGIN`, ...)
 * and gives a clear sentence for a write.
 */
export function checkStatementText(text: string): StatementCheck {
  if (text.length > SQL_LIMITS.maxTextChars) {
    return {
      ok: false,
      message: `A statement can have at most ${SQL_LIMITS.maxTextChars} characters.`,
    };
  }
  // PostgreSQL ends a line comment at a carriage return too, and counts form feeds and vertical
  // tabs as white space; this check does not. Text with such a character could be read as one
  // statement here and as another there, so it is refused (the editor and an opened file only
  // ever hold line feeds).
  if (CONTROL_CHARACTER.test(text)) {
    return {
      ok: false,
      message:
        "The statement contains a control character (a carriage return, for example) that cannot be sent. Use line feeds only.",
    };
  }
  const word = firstKeyword(text);
  if (word === "explain") return checkExplained(text);
  if (word === null) {
    const blank = /^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*$/.test(text);
    return { ok: false, message: blank ? "Type a statement to run." : NOT_ALLOWED_MESSAGE };
  }
  return (ALLOWED_FIRST_WORDS as readonly string[]).includes(word)
    ? { ok: true }
    : { ok: false, message: NOT_ALLOWED_MESSAGE };
}
