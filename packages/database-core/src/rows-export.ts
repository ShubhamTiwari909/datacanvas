/**
 * Exporting the rows of a table as a file (`docs/advanced-data-workspace-plan.md`, section 8; decision 158):
 * CSV, TSV, JSON, NDJSON or a script of INSERT statements, of the rows as filtered and sorted on screen, in a stream,
 * with limits.
 *
 * This file is what both providers and the web server share: the limits, the events a reader of rows
 * produces, and the FORMATTERS that turn those events into text a piece at a time. It talks to no database
 * and holds no row: a formatter turns the batch it is given into text and keeps only a flag or two.
 *
 * Rules the formatters keep:
 *  - NULL is an empty field in CSV and TSV unless the person names a word for it (an empty string stays
 *    empty), and `null` in JSON and NDJSON;
 *  - a value a spreadsheet would run as a formula gets a leading apostrophe, as in the SQL tab's export
 *    (`apps/web/features/sql/export.ts`, which a test pins this function against);
 *  - a file that was cut at a limit SAYS SO, at its end (the end is the only place a stream knows it): a
 *    `#` line in CSV and TSV, a `_meta` member in JSON, a last `_meta` line in NDJSON.
 */
import type { RowFilter, RowSort } from "./models.js";

/** The most rows in one export. */
export const EXPORT_MAX_ROWS = 100_000;
/** The most characters of file in one export (64 MB; the text is mostly ASCII, so about as many bytes). */
export const EXPORT_MAX_BYTES = 64 * 1024 * 1024;
/** The most rows fetched from the cursor at a time. */
export const EXPORT_BATCH_ROWS = 1000;
/** The first fetch is small, so a table of huge cells is not read 1,000 rows at a time before its size is known. */
export const EXPORT_FIRST_BATCH_ROWS = 10;
/** A fetch is sized to hold about this many characters (a few rows of big cells, many rows of small ones). */
export const EXPORT_BATCH_CHARS = 4_000_000;
/** The most characters of one cell; a longer value is cut, and the file counts how many were. */
export const EXPORT_CELL_CHARS = 1_000_000;

export const ROWS_EXPORT_FORMATS = ["csv", "tsv", "json", "ndjson", "sql"] as const;
export type ExportRowsFormat = (typeof ROWS_EXPORT_FORMATS)[number];

/** The most rows an export of chosen rows can name. */
export const EXPORT_MAX_KEYS = 500;

/** What the rows are read with: the same sort and conditions as on screen. No paging. */
export interface ExportRowsOptions {
  /** Columns whose names look sensitive are left OUT of the file unless named here. */
  revealColumns: string[];
  sort?: RowSort | null;
  filters?: RowFilter[];
  /**
   * Only these rows (decision 168): each one named by the table's WHOLE key (one entry per key column, in any
   * order), at most `EXPORT_MAX_KEYS`. A key that matches no row gives no row. A table without a key, a key that
   * is not the table's key, and a key column that looks sensitive and was not revealed are refused.
   */
  keys?: ReadonlyArray<ReadonlyArray<{ column: string; value: string }>>;
}

/** The part of an `AbortSignal` a reader of rows looks at (this package has no DOM types). */
export interface ExportSignal {
  readonly aborted: boolean;
}

export interface ExportColumn {
  name: string;
  dataType: string;
  /** `GENERATED ... STORED`: an INSERT cannot set it, so a script leaves it out. */
  generated?: boolean;
  /** `GENERATED ALWAYS AS IDENTITY`: a script keeps it, with `OVERRIDING SYSTEM VALUE`. */
  identityAlways?: boolean;
}

/** What a reader of rows produces, in order: one `start`, any number of `rows`, one `end`. */
export type ExportEvent =
  | {
      kind: "start";
      columns: ExportColumn[];
      /** Columns left out because their names look sensitive and they were not revealed. */
      leftOut: string[];
    }
  | { kind: "rows"; rows: Array<Array<string | null>>; cellsCut: number }
  | { kind: "end"; rows: number; cut: ExportCut; cellsCut: number };

/** Why a file stops before the end of the table, or null when it holds every row. */
export type ExportCut = "rows" | "bytes" | null;

export interface FormatOptions {
  format: ExportRowsFormat;
  /** CSV only. A tab is TSV. */
  delimiter: "," | ";";
  /** A first line with the column names (CSV and TSV). */
  header: boolean;
  /** What NULL is written as in CSV and TSV; the empty string by default. */
  nullText: string;
  /** Add the notes about the file even when it was not cut. */
  meta: boolean;
}

export interface FileSource {
  table: { schema: string; name: string };
  at: Date;
  /** The conditions in words that name no value (`status equals`), for the notes. */
  filters: string[];
}

// ----------------------------------------------------------------- defuse ---

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const FORMULA_START = /^[=+\-@|\t\r\n]/;

/** The value as a spreadsheet would read it safely: the same rule as the SQL tab's export. */
export function defuse(value: string): string {
  // Some spreadsheets ignore white space and control characters in front of a formula.
  // eslint-disable-next-line no-control-regex
  const bare = value.replace(/^[\s\u0000-\u001f]+/, "");
  const formula = FORMULA_START.test(value) || FORMULA_START.test(bare);
  return formula && !NUMBER.test(value) ? `'${value}` : value;
}

// -------------------------------------------------------------- formatter ---

export interface Formatter {
  /** Text to send before any row. */
  start(columns: readonly ExportColumn[], leftOut: readonly string[]): string;
  /** Text for a batch of rows. */
  rows(batch: ReadonlyArray<ReadonlyArray<string | null>>): string;
  /** Text to send after the last row. */
  end(info: { rows: number; cut: ExportCut; cellsCut: number; leftOut: readonly string[] }): string;
}

/** A key is never one that was already given, whatever the columns are called. */
export function uniqueKeys(names: readonly string[], reserved: readonly string[] = []): string[] {
  const taken = new Set<string>(reserved);
  return names.map((name) => {
    let key = name;
    for (let n = 2; taken.has(key); n++) key = `${name} (${n})`;
    taken.add(key);
    return key;
  });
}

const CUT_TEXT: Record<Exclude<ExportCut, null>, string> = {
  rows: `This file was cut at the limit of ${EXPORT_MAX_ROWS.toLocaleString("en-US")} rows. The table has more.`,
  bytes: `This file was cut at the limit of ${EXPORT_MAX_BYTES / (1024 * 1024)} MB. The table has more.`,
};

function notes(
  source: FileSource,
  info: { rows: number; cut: ExportCut; cellsCut: number; leftOut: readonly string[] },
): string[] {
  // A name comes from a database and may hold a line break (and so start a line of its own, in a
  // spreadsheet, with a formula): every name in the notes is cut to one line of plain characters.
  const one = (text: string): string =>
    // eslint-disable-next-line no-control-regex
    text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  const lines = [
    `Exported from ${one(source.table.schema)}.${one(source.table.name)} at ${source.at.toISOString()}.`,
    `${info.rows.toLocaleString("en-US")} ${info.rows === 1 ? "row" : "rows"}.`,
  ];
  if (source.filters.length > 0) lines.push(`Filtered by: ${source.filters.map(one).join("; ")}.`);
  if (info.leftOut.length > 0) {
    lines.push(`Left out because they look sensitive: ${info.leftOut.map(one).join(", ")}.`);
  }
  if (info.cellsCut > 0) {
    lines.push(
      `${info.cellsCut} ${info.cellsCut === 1 ? "value was" : "values were"} longer than ${EXPORT_CELL_CHARS.toLocaleString("en-US")} characters and cut.`,
    );
  }
  if (info.cut) lines.push(CUT_TEXT[info.cut]);
  return lines;
}

function delimitedFormatter(
  delimiter: string,
  options: FormatOptions,
  source: FileSource,
): Formatter {
  // With one column an empty field would be a blank line, which many readers skip: it is quoted then.
  let single = false;
  const field = (value: string | null): string => {
    const text = value === null ? options.nullText : value;
    // The word standing for NULL is defused too (a word that starts with "=" would be a formula in a spreadsheet),
    // except a lone dash, the usual word for "nothing" in a column of numbers.
    const safe = value === null && text === "-" ? text : defuse(text);
    const quote =
      safe.includes(delimiter) ||
      /["\r\n]/.test(safe) ||
      /^\s|\s$/.test(safe) ||
      (single && safe === "");
    return quote ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const line = (values: ReadonlyArray<string | null>) => values.map(field).join(delimiter);
  return {
    start: (columns) => {
      single = columns.length === 1;
      return options.header ? `${line(columns.map((c) => c.name))}\r\n` : "";
    },
    rows: (batch) => batch.map((row) => `${line(row)}\r\n`).join(""),
    end: (info) =>
      options.meta || info.cut
        ? notes(source, info)
            .map((n) => `# ${n}\r\n`)
            .join("")
        : "",
  };
}

function jsonFormatter(options: FormatOptions, source: FileSource): Formatter {
  let keys: string[] = [];
  let first = true;
  const object = (row: ReadonlyArray<string | null>): string =>
    JSON.stringify(Object.fromEntries(keys.map((k, i) => [k, row[i] ?? null])));
  const meta = (info: Parameters<Formatter["end"]>[0]) => ({
    source: `${source.table.schema}.${source.table.name}`,
    exportedAt: source.at.toISOString(),
    rows: info.rows,
    cut: info.cut,
    columnsLeftOut: [...info.leftOut],
    valuesCut: info.cellsCut,
    filters: source.filters,
  });
  if (options.format === "ndjson") {
    return {
      start: (columns) => {
        // `_meta` is the key of the last line of notes: a column of that name must not look like it.
        keys = uniqueKeys(
          columns.map((c) => c.name),
          ["_meta"],
        );
        return "";
      },
      rows: (batch) => batch.map((row) => `${object(row)}\n`).join(""),
      end: (info) => (options.meta || info.cut ? `${JSON.stringify({ _meta: meta(info) })}\n` : ""),
    };
  }
  // JSON is always an object with the rows and the notes, so a file that was cut can say so.
  return {
    start: (columns) => {
      keys = uniqueKeys(columns.map((c) => c.name));
      return '{"rows":[';
    },
    rows: (batch) => {
      // The comma goes before every row but the very first of the file.
      let out = "";
      for (const row of batch) {
        out += `${first ? "" : ","}\n  ${object(row)}`;
        first = false;
      }
      return out;
    },
    end: (info) => `${first ? "" : "\n"}],\n"_meta":${JSON.stringify(meta(info))}}\n`,
  };
}

// ------------------------------------------------------------ INSERT script ---

/** Rows in one INSERT statement of a script. */
export const SQL_ROWS_PER_STATEMENT = 100;

/** One line of plain characters for a comment (`--` ends at a line break, and PostgreSQL counts a lone CR as one). */
function commentText(text: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** An identifier in double quotes, a quote doubled. Names that hold a line break are fine here: they are in quotes. */
function sqlName(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A value as a text literal PostgreSQL converts to the column's type, or NULL. */
function sqlLiteral(value: string | null): string {
  return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

/**
 * A script of `INSERT` statements (decision 167): `BEGIN; ... COMMIT;`, every value a quoted text literal (the form
 * PostgreSQL converts to the column's type) or NULL, every identifier quoted, one statement for each 100 rows.
 * Generated columns are left out (an INSERT cannot set them) and identity-always columns are kept with
 * `OVERRIDING SYSTEM VALUE`. A table with nothing left to insert writes `DEFAULT VALUES` for each row.
 *
 * **A script that is not whole rolls itself back:** if the file was cut for any reason (a limit, a value over the cell
 * limit) or columns were left out because their names look sensitive, it ends with a comment that says so and
 * `ROLLBACK;` in place of `COMMIT;`. If the export fails after the first
 * byte there is no end at all: `BEGIN;` is never committed. Only a complete script commits.
 *
 * Comments never hold a raw name: every name in a comment is flattened to one line of plain characters, so a table
 * called `x` + a line break + `DROP TABLE y;` cannot become a statement.
 */
function sqlFormatter(source: FileSource): Formatter {
  let target = "";
  let columnList = "";
  let override = false;
  let insertColumns: number[] = [];
  const tuple = (row: ReadonlyArray<string | null>): string =>
    `(${insertColumns.map((i) => sqlLiteral(row[i] ?? null)).join(", ")})`;
  return {
    start: (columns, leftOut) => {
      target = `${sqlName(source.table.schema)}.${sqlName(source.table.name)}`;
      const kept = columns.flatMap((c, i) => (c.generated ? [] : [i]));
      insertColumns = kept;
      columnList = kept.map((i) => sqlName(columns[i]!.name)).join(", ");
      override = kept.some((i) => columns[i]!.identityAlways);
      const left = columns.filter((c) => c.generated).map((c) => commentText(c.name));
      const lines = [
        `-- DataCanvas export of ${commentText(source.table.schema)}.${commentText(source.table.name)} at ${source.at.toISOString()}.`,
        "-- Run it in an empty copy of the table: it inserts, it does not replace.",
      ];
      if (source.filters.length > 0) {
        lines.push(`-- Filtered by: ${source.filters.map((f) => commentText(f)).join("; ")}.`);
      }
      if (leftOut.length > 0) {
        lines.push(
          `-- Left out because they look sensitive: ${leftOut.map((n) => commentText(n)).join(", ")}.`,
        );
      }
      if (left.length > 0) {
        lines.push(`-- Left out because they are generated by the database: ${left.join(", ")}.`);
      }
      // `SET LOCAL` after `BEGIN`: the settings last for the transaction and leave the person's session as it was. The
      // text of a date, an interval and a number was written in ISO, postgres-style and shortest-exact forms (the export
      // reads with these settings), and the recipient's own DateStyle could read '03.04.2026' as March or April.
      lines.push(
        "BEGIN;",
        "SET LOCAL standard_conforming_strings = on;",
        "SET LOCAL datestyle = 'ISO, MDY';",
        "SET LOCAL intervalstyle = 'postgres';",
      );
      return `${lines.join("\n")}\n`;
    },
    rows: (batch) => {
      let out = "";
      for (let at = 0; at < batch.length; at += SQL_ROWS_PER_STATEMENT) {
        const part = batch.slice(at, at + SQL_ROWS_PER_STATEMENT);
        if (insertColumns.length === 0) {
          out += part.map(() => `INSERT INTO ${target} DEFAULT VALUES;\n`).join("");
          continue;
        }
        out += `INSERT INTO ${target} (${columnList})${override ? " OVERRIDING SYSTEM VALUE" : ""} VALUES\n`;
        out += `${part.map((row) => `  ${tuple(row)}`).join(",\n")};\n`;
      }
      return out;
    },
    end: (info) => {
      // Columns left out because their names look sensitive are not in the script: it would put NULL or the default
      // where the real values were, and commit that. It is not a copy of the table, so it does not commit either.
      const whole = info.cut === null && info.cellsCut === 0 && info.leftOut.length === 0;
      const lines: string[] = [];
      if (override) {
        lines.push(
          "-- Identity sequences are not moved by this script: set them with setval() if rows are added later.",
        );
      }
      if (whole) {
        lines.push(
          `-- ${info.rows.toLocaleString("en-US")} ${info.rows === 1 ? "row" : "rows"}.`,
          "COMMIT;",
        );
      } else if (info.cut === null && info.cellsCut === 0) {
        lines.push(
          "-- INCOMPLETE: columns were left out because their names look sensitive, so this is not a copy of the table and it does not commit.",
          "-- Show those columns in the grid and export again, or read the script and change ROLLBACK to COMMIT yourself.",
          "ROLLBACK;",
        );
      } else {
        lines.push(
          `-- INCOMPLETE: this script was cut (${[
            info.cut ? CUT_TEXT[info.cut] : null,
            info.cellsCut > 0
              ? `${info.cellsCut} ${info.cellsCut === 1 ? "value was" : "values were"} longer than ${EXPORT_CELL_CHARS.toLocaleString("en-US")} characters and cut`
              : null,
          ]
            .filter((t): t is string => t !== null)
            .join(" ")}) so it does not commit.`,
          "ROLLBACK;",
        );
      }
      return `${lines.join("\n")}\n`;
    },
  };
}

export function createFormatter(options: FormatOptions, source: FileSource): Formatter {
  if (options.format === "sql") return sqlFormatter(source);
  if (options.format === "csv") return delimitedFormatter(options.delimiter, options, source);
  if (options.format === "tsv") return delimitedFormatter("\t", options, source);
  return jsonFormatter(options, source);
}

/** The file name's extension and the media type of a format. */
export const EXPORT_MEDIA: Record<ExportRowsFormat, { extension: string; type: string }> = {
  csv: { extension: "csv", type: "text/csv; charset=utf-8" },
  tsv: { extension: "tsv", type: "text/tab-separated-values; charset=utf-8" },
  json: { extension: "json", type: "application/json; charset=utf-8" },
  ndjson: { extension: "ndjson", type: "application/x-ndjson; charset=utf-8" },
  sql: { extension: "sql", type: "application/sql; charset=utf-8" },
};
