/**
 * Editing a text value that a page of rows cut short (`docs/write-side-v2-plan.md`, section 7), with no React so
 * every rule is tested on its own.
 *
 * A grid cell is cut at 2,000 characters, so the person cannot edit it in place and the change could not be checked
 * against it. The cell's dialog reads the WHOLE value from the database (`getCell`) and offers Edit only when the
 * server says the whole value is editable (at most 100,000 characters: what a change can carry). The value read is
 * then the change's `before` (what "expected" is checked against when it is applied), never the cut text.
 */
import type { CellRead, EditableColumn, RowCell, RowColumn } from "@datacanvas/database-core";
import { WRITE_MAX_CHANGE_VALUE_CHARS } from "@datacanvas/shared-types";
import { gridCellBlock } from "./pending-cells";

export { hasCarriageReturn, isSameText, normalizeLineEndings } from "./line-endings";

const number = (n: number) => n.toLocaleString("en-US");

/** The tooltip of a cut text cell whose whole value can be edited from its dialog. */
export const CUT_TEXT_OPEN_TEXT =
  "Only part of this value is shown here. Open it to edit the whole value.";

/** Shown when the value is larger than the 1,000,000 characters the server sends. */
export const CUT_TEXT_TOO_LARGE_TEXT =
  "This value is longer than 1 million characters, so it is not read here and cannot be edited. Use the SQL tab to look at parts of it.";

/** Shown when the whole value was read but a change cannot carry it. */
export function cutTextTooLongText(length: number | null): string {
  const size =
    length === null ? "This value" : `This value is ${number(length)} characters long. It`;
  return `${size} is longer than ${number(WRITE_MAX_CHANGE_VALUE_CHARS)} characters, which is the most a change can carry, so it can be read and copied here but not edited.`;
}

/** What the dialog does with the answer of `getCell`. */
export type WholeValue =
  | { kind: "too_large" }
  | { kind: "read_only"; text: string; length: number | null }
  | { kind: "editable"; text: string | null };

/** `editable` is the server's word (measured in the database before the value was sent); a value is never edited without it. */
export function wholeValueOf(cell: CellRead): WholeValue {
  if (cell.tooLarge) return { kind: "too_large" };
  // SQL NULL (the cell changed since the page was read): nothing is longer than a change can carry.
  if (cell.value === null) return { kind: "editable", text: null };
  if (!cell.editable) return { kind: "read_only", text: cell.value, length: cell.length };
  return { kind: "editable", text: cell.value };
}

/**
 * The types whose whole value the server reads: `text`, `varchar` (as `format_type` prints it) and `citext`. `char(n)`,
 * `name`, a domain and the rest of the string category are left out, as the server leaves them out.
 */
const READABLE_TYPE = /^(text|character varying(\(\d+\))?|(?:"?\w+"?\.)?"?citext"?)$/i;

/**
 * Can this cut text cell be edited through its dialog? Every rule of the grid still applies (the row can be found by
 * its key, the column is not part of the key, hidden, filled by the database or of a type that cannot be edited);
 * only "this value was cut" is lifted, because the dialog reads the whole value itself. Only `text`, `varchar`
 * and `citext` columns (the server refuses the rest of the string types when asked).
 */
export function canEditCutText(
  rowBlock: string | null,
  column: Pick<RowColumn, "name" | "masked" | "kind">,
  cell: RowCell,
  info: EditableColumn | undefined,
): boolean {
  if (column.kind !== "text" || !cell.truncated || cell.value === null) return false;
  if (!info || !READABLE_TYPE.test(info.dataType)) return false;
  return gridCellBlock(rowBlock, column, { value: cell.value, truncated: false }, info) === null;
}

/** Whether a text a person typed can be kept as the new value, and why not. */
export function newTextProblem(text: string): string | null {
  return text.length > WRITE_MAX_CHANGE_VALUE_CHARS
    ? `This is longer than ${number(WRITE_MAX_CHANGE_VALUE_CHARS)} characters, which is the most a change can carry.`
    : null;
}

/** Shown instead of an editor when the value has a carriage return: a text field cannot keep it. */
export const CUT_TEXT_LINE_ENDINGS_TEXT =
  "This value has Windows line endings (or a bare carriage return), which this editor cannot keep exactly. Use the row form or SQL.";
