/**
 * Exporting the rows of a table as a file (`docs/advanced-data-workspace-plan.md`, section 8; decision 158):
 * CSV, TSV, JSON or NDJSON, of the rows as filtered and sorted on screen, in a stream, with limits.
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
/** Rows fetched from the cursor at a time. */
export const EXPORT_BATCH_ROWS = 1000;
/** The most characters of one cell; a longer value is cut, and the file counts how many were. */
export const EXPORT_CELL_CHARS = 1_000_000;

export const ROWS_EXPORT_FORMATS = ["csv", "tsv", "json", "ndjson"] as const;
export type ExportRowsFormat = (typeof ROWS_EXPORT_FORMATS)[number];

/** What the rows are read with: the same sort and conditions as on screen. No paging. */
export interface ExportRowsOptions {
  /** Columns whose names look sensitive are left OUT of the file unless named here. */
  revealColumns: string[];
  sort?: RowSort | null;
  filters?: RowFilter[];
}

/** The part of an `AbortSignal` a reader of rows looks at (this package has no DOM types). */
export interface ExportSignal {
  readonly aborted: boolean;
}

export interface ExportColumn {
  name: string;
  dataType: string;
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
export function uniqueKeys(names: readonly string[]): string[] {
  const taken = new Set<string>();
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
  const lines = [
    `Exported from ${source.table.schema}.${source.table.name} at ${source.at.toISOString()}.`,
    `${info.rows.toLocaleString("en-US")} ${info.rows === 1 ? "row" : "rows"}.`,
  ];
  if (source.filters.length > 0) lines.push(`Filtered by: ${source.filters.join("; ")}.`);
  if (info.leftOut.length > 0) {
    lines.push(`Left out because they look sensitive: ${info.leftOut.join(", ")}.`);
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
  const field = (value: string | null): string => {
    const text = value === null ? options.nullText : value;
    // The word standing for NULL is the person's own; it is not a formula to defuse.
    const safe = value === null ? text : defuse(text);
    const quote = safe.includes(delimiter) || /["\r\n]/.test(safe) || /^\s|\s$/.test(safe);
    return quote ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const line = (values: ReadonlyArray<string | null>) => values.map(field).join(delimiter);
  return {
    start: (columns) => (options.header ? `${line(columns.map((c) => c.name))}\r\n` : ""),
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
        keys = uniqueKeys(columns.map((c) => c.name));
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

export function createFormatter(options: FormatOptions, source: FileSource): Formatter {
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
};
