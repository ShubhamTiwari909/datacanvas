/**
 * The key of a row on a page, for reading one of its cells whole (`getCell`). The key columns are the
 * page's own (`page.order`); each must be on the page, read (not hidden) and complete (not cut at the
 * cell limit), or the row cannot be named and there is no key.
 */
import type { KeyValue, RowPage } from "@datacanvas/database-core";

export function wholeCellKey(page: RowPage, rowIndex: number): KeyValue[] | null {
  const row = page.rows[rowIndex];
  if (!row || page.order.kind === "none") return null;
  const key: KeyValue[] = [];
  for (const name of page.order.columns) {
    const index = page.columns.findIndex((c) => c.name === name);
    const column = page.columns[index];
    const cell = row[index];
    if (!column || !cell || column.masked || cell.truncated || cell.value === null) return null;
    key.push({ column: name, value: cell.value });
  }
  return key.length > 0 ? key : null;
}
