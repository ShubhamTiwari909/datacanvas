/**
 * A change of every row the filter on screen matches (`docs/write-side-v2-plan.md`, section 6): "Set a value on all
 * matching rows" and "Delete all matching rows". Pure functions, no React.
 *
 * The filter travels to the preview exactly as the grid reads the page with it (`filters`, `revealColumns`); the
 * server finds the keys of the matching rows, holds them, and answers with their count (`confirmRows`). The person
 * types that count to apply, and the count typed is what the apply request carries.
 */
import type {
  DeleteMatchingChange,
  EditableColumn,
  RowColumn,
  RowFilter,
  TableEditInfo,
  TableRef,
  UpdateMatchingChange,
} from "@datacanvas/database-core";

/** The buttons' words, also the history's labels (`CHANGE_LABEL`). */
export const MATCHING_SET_LABEL = "Set a value on all matching rows";
export const MATCHING_DELETE_LABEL = "Delete all matching rows";
/** One sentence, in the server's words: how the rows are chosen and how they are found when applying. */
export const MATCHING_DESCRIPTION =
  "Rows are chosen by the filter, and are found by their key when you apply.";

export const isMatchingKind = (kind: string): kind is "update_matching" | "delete_matching" =>
  kind === "update_matching" || kind === "delete_matching";

/** "1 row", "1,234 rows": a count as the plan writes it. */
export const rowsText = (n: number): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;

/** The label of the field the count is typed in. */
export const typeCountLabel = (n: number): string => `Type ${n.toLocaleString("en-US")} to confirm`;

/**
 * The count the person typed, or null when it is not a count: digits, with or without thousands separators (a comma
 * every three digits, as the count is shown). Spaces around it are ignored; anything else is not a count.
 */
export function parseTypedCount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed) && !/^\d{1,3}(,\d{3})+$/.test(trimmed)) return null;
  const n = Number(trimmed.replaceAll(",", ""));
  return Number.isSafeInteger(n) ? n : null;
}

/** Whether what was typed is the count the preview found (compared as numbers). */
export function typedCountMatches(text: string, confirmRows: number | null): boolean {
  if (confirmRows === null) return true;
  return parseTypedCount(text) === confirmRows;
}

/**
 * Whether Apply is enabled for a preview that is ready: the tick for a destructive change, and for a change of the
 * rows a filter matches the count typed as well. Wrong or empty keeps it disabled.
 */
export function canApplyPreview(input: {
  ready: boolean;
  destructive: boolean;
  read: boolean;
  confirmRows: number | null;
  typed: string;
}): boolean {
  if (!input.ready) return false;
  if (input.destructive && !input.read) return false;
  return typedCountMatches(input.typed, input.confirmRows);
}

/**
 * Whether the two buttons are offered: the filter has at least one condition (never "the whole table") and the
 * table's rows can be edited (`info.editable`: a key, writes on and unlocked).
 */
export function offersMatching(
  filters: readonly RowFilter[],
  info: Pick<TableEditInfo, "editable"> | null,
): boolean {
  return filters.length > 0 && info?.editable === true;
}

/**
 * The columns a value can be set on: as the bulk "Set a value" offers them (not the key, not filled by the database,
 * not binary data), and not a column hidden on the page (a name that looks sensitive and was not revealed).
 */
export function matchingSetChoices(
  info: TableEditInfo,
  columns: readonly Pick<RowColumn, "name" | "masked">[],
): EditableColumn[] {
  const masked = new Set(columns.filter((c) => c.masked).map((c) => c.name));
  return info.columns.filter(
    (c) => c.editable && !c.generated && c.identity !== "always" && !c.inKey && !masked.has(c.name),
  );
}

export function buildUpdateMatching(
  table: TableRef,
  filters: readonly RowFilter[],
  revealColumns: readonly string[],
  column: string,
  value: string | null,
): UpdateMatchingChange {
  return {
    kind: "update_matching",
    table: { schema: table.schema, name: table.name },
    filters: filters.map((f) => ({ ...f })),
    revealColumns: [...revealColumns],
    set: { column, value },
  };
}

export function buildDeleteMatching(
  table: TableRef,
  filters: readonly RowFilter[],
  revealColumns: readonly string[],
): DeleteMatchingChange {
  return {
    kind: "delete_matching",
    table: { schema: table.schema, name: table.name },
    filters: filters.map((f) => ({ ...f })),
    revealColumns: [...revealColumns],
  };
}
