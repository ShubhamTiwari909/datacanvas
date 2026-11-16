/**
 * The short notes under the toolbar about how a page was read: its order, columns
 * left out, hidden columns and limits that cut it. Each says something a reader
 * could otherwise miss, and nothing here touches a value.
 */
import { ROWS_MAX_OFFSET, type RowPage } from "@datacanvas/database-core";

const number = (n: number): string => new Intl.NumberFormat().format(n);

export function pageNotes(page: RowPage): string[] {
  const notes: string[] = [];
  if (page.order.kind === "primary_key") {
    notes.push(`Ordered by ${page.order.columns.join(", ")} (the primary key).`);
  } else if (page.order.kind === "unique_index") {
    notes.push(`Ordered by ${page.order.columns.join(", ")} (a unique index).`);
  } else {
    notes.push(
      `This table has no key to order by, so the order is not guaranteed and only the first ${number(ROWS_MAX_OFFSET)} rows can be reached.`,
    );
  }
  if (page.hiddenColumns > 0) {
    notes.push(
      `Showing the first ${number(page.columns.length)} of ${number(page.columns.length + page.hiddenColumns)} columns.`,
    );
  }
  const hidden = page.columns.filter((c) => c.masked).length;
  if (hidden > 0) {
    notes.push(
      `${hidden === 1 ? "A column whose name looks sensitive was" : `${hidden} columns whose names look sensitive were`} not read. Show reveals one for this view only.`,
    );
  }
  if (page.rowSecurity === "applies") {
    notes.push(
      "Row-level security is on for this table, so you may not be seeing every row: the database decides which rows this user can read.",
    );
  }
  if (page.cutBySize) {
    notes.push(
      "This page was shortened to keep the response small. Next continues after the last row shown.",
    );
  }
  if (page.offsetCapped) {
    notes.push(
      `There are more rows, but past the first ${number(ROWS_MAX_OFFSET)} they cannot be reached in a table without a key.`,
    );
  }
  return notes;
}
