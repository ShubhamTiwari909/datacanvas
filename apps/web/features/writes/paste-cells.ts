/** Turn clipboard TSV into pending edits for one rectangular block on the current grid page. */
import {
  EDIT_CELLS_MAX_CELLS,
  MAX_BULK_ROWS,
  MAX_CHANGE_VALUE_CHARS,
} from "@datacanvas/database-core";
import { IMPORT_MAX_BODY_BYTES } from "@datacanvas/shared-types";
import { parseCsv } from "@/features/import/csv-parse";
import { BODY_LIMIT_TEXT, type SetPendingCell } from "./pending-cells";

type Target = Omit<SetPendingCell, "type" | "after">;
type Paste = { cells: SetPendingCell[] } | { reason: string };

export function planCellPaste(
  text: string,
  startRow: number,
  startColumn: number,
  page: { rows: number; columns: number },
  targetAt: (row: number, column: number) => Target | string,
): Paste {
  if (text.length > IMPORT_MAX_BODY_BYTES) return { reason: BODY_LIMIT_TEXT };
  const parsed = parseCsv(text, "\t", "clipboard");
  if (!parsed.ok) {
    const reason =
      parsed.refusal === "cell_too_long"
        ? `Each pasted value can have up to ${MAX_CHANGE_VALUE_CHARS.toLocaleString("en-US")} characters.`
        : parsed.refusal === "too_many_rows"
          ? `Paste up to ${MAX_BULK_ROWS} rows at a time.`
          : "Copy a rectangular block of cells from the spreadsheet and try again.";
    return { reason };
  }
  const height = parsed.rows.length;
  const width = parsed.rows[0]!.length;
  if (startRow + height > page.rows || startColumn + width > page.columns) {
    return {
      reason:
        "The pasted block must fit on this page. Choose a smaller block or start at another cell.",
    };
  }
  if (height * width > EDIT_CELLS_MAX_CELLS) {
    return {
      reason: `Paste up to ${EDIT_CELLS_MAX_CELLS.toLocaleString("en-US")} cells at a time.`,
    };
  }

  const cells: SetPendingCell[] = [];
  for (const [offset, values] of parsed.rows.entries()) {
    for (const [index, value] of values.entries()) {
      const target = targetAt(startRow + offset, startColumn + index);
      if (typeof target === "string")
        return {
          reason: `Paste stopped at row ${startRow + offset + 1}, column ${startColumn + index + 1}. ${target}`,
        };
      cells.push({ type: "set", ...target, after: value });
    }
  }
  return { cells };
}
