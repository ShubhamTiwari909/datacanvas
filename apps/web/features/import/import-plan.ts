/**
 * From a parsed file to an import (`docs/advanced-data-workspace-plan.md`, section 9; decision 160): which file
 * column goes to which column of the table, how an empty field and a word such as "NULL" are read, which columns
 * the table needs that the file does not give, and the change that is previewed. Pure functions, no React.
 *
 * A name in the file is NEVER used as an identifier: the person chooses a column of the table for each file
 * column, and the change carries the table's own column names. The names of the file are only compared with the
 * table's, to suggest a choice.
 */
import {
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  type InsertRowsChange,
  type TableEditInfo,
  type TableRef,
} from "@datacanvas/database-core";

/** How a field is read: an empty field is NULL or the empty string, and these exact words are NULL as well. */
export interface NullRule {
  emptyIsNull: boolean;
  words: readonly string[];
}

export const DEFAULT_NULL_RULE: NullRule = { emptyIsNull: true, words: [] };

/** The words a person is likely to want as NULL, offered as a choice. */
export const COMMON_NULL_WORDS = ["NULL", "\\N", "n/a", "NA"] as const;

/** One field as the database will get it: text, or null. A word is matched exactly, with its case and spaces. */
export function readField(raw: string, rule: NullRule): string | null {
  if (raw === "") return rule.emptyIsNull ? null : "";
  return rule.words.includes(raw) ? null : raw;
}

/** The columns the person can import into: those a person can give a value to. */
export function importableColumns(info: TableEditInfo): TableEditInfo["columns"] {
  return info.columns.filter((c) => c.editable && !c.generated);
}

/**
 * A suggestion for each file column: the column of the table with the same name (exactly, then without regard to
 * case and to `_`, `-` and spaces), each table column at most once; null (ignore) for the rest.
 */
export function suggestMapping(
  header: readonly string[],
  info: TableEditInfo,
): Array<string | null> {
  const names = importableColumns(info).map((c) => c.name);
  const taken = new Set<string>();
  const loose = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  return header.map((h) => {
    const exact = names.find((n) => n === h && !taken.has(n));
    const found = exact ?? names.find((n) => loose(n) === loose(h) && !taken.has(n));
    if (found === undefined) return null;
    taken.add(found);
    return found;
  });
}

/** The columns the table needs a value for (NOT NULL, no default, not filled by the database) that are not mapped. */
export function missingRequired(
  info: TableEditInfo,
  mapping: ReadonlyArray<string | null>,
): string[] {
  const mapped = new Set(mapping.filter((m): m is string => m !== null));
  // Every column of the table, not only those a person can give a value to here: a NOT NULL column with no default
  // that the file cannot fill (a `bytea`, say) is named now, not refused by the database as a bare not-null error.
  return info.columns
    .filter(
      (c) =>
        !c.generated && !c.nullable && !c.hasDefault && c.identity === null && !mapped.has(c.name),
    )
    .map((c) => c.name);
}

/** Why the choices cannot be turned into an import yet, or null when they can. */
export function mappingProblem(
  info: TableEditInfo,
  mapping: ReadonlyArray<string | null>,
  dataRows: number,
): string | null {
  const chosen = mapping.filter((m): m is string => m !== null);
  if (chosen.length === 0)
    return "Choose a column of the table for at least one column of the file.";
  if (chosen.length > IMPORT_MAX_COLUMNS) return "Too many columns for one import.";
  if (new Set(chosen).size !== chosen.length) {
    return "Two columns of the file go to the same column of the table. Ignore one of them.";
  }
  const importable = new Set(importableColumns(info).map((c) => c.name));
  if (chosen.some((c) => !importable.has(c)))
    return "A column chosen cannot be given a value here.";
  if (dataRows === 0) return "The file has no rows below its first row.";
  if (dataRows > IMPORT_MAX_ROWS) return "Too many rows for one import.";
  const missing = missingRequired(info, mapping);
  if (missing.length > 0) {
    const importable = new Set(importableColumns(info).map((c) => c.name));
    const stuck = missing.filter((c) => !importable.has(c));
    if (stuck.length > 0) {
      return `${stuck.join(", ")} ${stuck.length === 1 ? "needs" : "need"} a value (NOT NULL, no default) but cannot be given one by an import, so the database would refuse every row.`;
    }
    return `${missing.join(", ")} ${missing.length === 1 ? "needs" : "need"} a value (NOT NULL, no default): choose ${missing.length === 1 ? "a column of the file" : "columns of the file"} for ${missing.length === 1 ? "it" : "them"}.`;
  }
  return null;
}

export interface ImportInput {
  /** All rows of the file, the header (when there is one) first. */
  rows: readonly (readonly string[])[];
  header: boolean;
  /** For each column of the file: the column of the table it goes to, or null to ignore it. */
  mapping: ReadonlyArray<string | null>;
  rule: NullRule;
}

/** The rows below the header. */
export const dataRowsOf = (
  input: Pick<ImportInput, "rows" | "header">,
): readonly (readonly string[])[] => (input.header ? input.rows.slice(1) : input.rows);

/** The change to preview: the table's columns that were chosen, and every row read by the rule. */
export function buildImport(table: TableRef, input: ImportInput): InsertRowsChange {
  const at: number[] = [];
  const columns: string[] = [];
  input.mapping.forEach((column, i) => {
    if (column !== null) {
      at.push(i);
      columns.push(column);
    }
  });
  return {
    kind: "insert_rows",
    table: { schema: table.schema, name: table.name },
    columns,
    rows: dataRowsOf(input).map((row) => at.map((i) => readField(row[i] ?? "", input.rule))),
  };
}

/** The first rows as they will be read (text, or NULL), for the person to check the choices against. */
export function previewRows(
  input: ImportInput,
  count = 10,
): { columns: string[]; rows: Array<Array<string | null>> } {
  const change = buildImport({ schema: "", name: "" }, { ...input, rows: capRows(input, count) });
  return { columns: change.columns, rows: change.rows };
}

function capRows(input: ImportInput, count: number): readonly (readonly string[])[] {
  return input.header ? input.rows.slice(0, count + 1) : input.rows.slice(0, count);
}

/** A row number of the validation report (1-based among the data rows) as the file's row number (the header is row 1). */
export const fileRowNumber = (position: number, header: boolean): number =>
  position + (header ? 1 : 0);

/** The row number of the file's data in the words of the screen. */
export function rowsWords(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "row" : "rows"}`;
}
