---
title: Bulk edit and CSV import
description: Edit chosen or matching rows, or import a CSV file through a preview and a single all-or-nothing transaction.
---

Both features need the same [three switches](/guides/editing/) as any change (`--enable-writes`, a local
database, the unlock) and go through the same preview and apply.

## Change several rows together

With writes unlocked, the Data section shows a checkbox on each row of an editable table.

- A click with **Shift** chooses a range; the header's box chooses the page.
- The choice is **kept while you change page or filter** (held in browser memory only).
- With rows chosen: **Set a value** puts one value in one column of all of them, and **Delete rows**
  removes them. At most **500 rows** at a time, always through a preview.

How it behaves:

- Each row is the same single-row `UPDATE` or `DELETE` as a normal edit, found by the table's **whole
  key** with every value bound. **Every row must change exactly one row, or the whole transaction is
  rolled back.**
- A row that **changed since you loaded it** is left out at the preview and counted, without showing its
  values. For **Delete**, only a row that is **gone** is left out, because a delete compares no values.
- If a row changes between the preview and apply, nothing is written and the page says so.
- A row named twice in different spellings of its key (`1` and `01`) is refused at the preview.

## Change all rows a filter matches

Apply a filter, then choose **Set a value** or **Delete** for all matching rows. Type the count shown in the preview to confirm. A change can cover up to 100,000 rows. Apply uses the row keys captured at preview. If a captured row is gone, the change rolls back. This mode does not compare the values you saw in the grid.

## Edit cells in the grid

With writes unlocked, double-click an editable cell or focus it and press **Enter**. Stage the new
value, then choose **Review** and **Preview** before applying your pending edits. A row whose edited
cells changed since you loaded it is skipped at preview and counted. Key, hidden, generated, and
`bytea` columns are excluded from inline editing.

For a truncated `text`, `varchar`, or `citext` value, open the cell's value dialog. You can read
and copy up to 1,000,000 characters. Choose **Edit this value** for an editable value up to 100,000
characters.

## Paste cells from a spreadsheet

Copy a rectangular selection, focus its top-left destination cell with Tab and the arrow keys, and paste. The block must fit on the current page and every destination must be editable. Empty cells paste as empty strings. The grid stages the block as one change, so **Undo last** takes it back together. Choose **Review** and then **Preview** before you apply it.

The grid accepts up to 500 rows, 50 cells per row, and 2,500 pending cells in total. A paste cannot change key, hidden, generated, or truncated cells.

## Import a CSV file

**Import CSV** (in the Data section) reads a file from your computer. It is read **in your browser** and
is not uploaded as a file; the server never parses it.

| Limit      | Value                                                          |
| ---------- | -------------------------------------------------------------- |
| Rows       | 100,000                                                        |
| Columns    | 50                                                             |
| File size  | 20 MB (about 32 MB as the JSON request)                        |
| One cell   | 10,000 characters                                              |
| Encoding   | UTF-8, Windows-1252 / Latin-1 or UTF-16 with a byte order mark |
| Delimiters | comma, semicolon, tab or pipe, with or without a header        |

Steps:

Choose **Add new rows only**, **Update existing rows, add the others**, or **Update existing rows only**. Both update modes require an eligible primary key or unique constraint. In the add-or-update mode, choose **Leave existing rows as they are** to insert only new rows. Update-only mode leaves out file rows with no matching key and reports how many it skipped.

1. **Choose a column of the table** for each column of the file, or leave it out. A name in the file is
   **never used as a name in a statement**; you map file columns to table columns.
2. Say whether an empty field is NULL or an empty string, and which words (for example `NULL`) also mean
   NULL.
3. **Validate the file**: the database checks every row against the table's rules without writing, and
   names the rows of the file that fail. Columns the table needs that the file does not give are named
   before you can preview.
4. **Preview the import**: the statement and how many batches it takes.
5. **Apply** processes the included rows in **one transaction**, in batches of 500. If any row fails during apply, the import rolls back.
   **Cancel and roll back** stops it; closing the dialog or losing the connection also rolls back.

Choose **Leave out the failing rows** after validation to recheck the remaining rows and download a rejects CSV. DataCanvas can list up to 1,000 failed rows. The rejects file includes the original fields and a `datacanvas_reject_v1` column explaining each rejection. Fix the rows in that file and reopen it to retry. The dialog offers to remove the diagnostic column before importing.

## Things to know

- The import mode determines the statement shown in the preview. Column names come from the catalog and values are bound.
- Database triggers can run during apply. In an upsert, insert triggers can run for rows that are updated too.
- A committed import is **not undone** by DataCanvas. When it matters, try the file on a test copy first.
- An import with values for an identity column warns that the sequence does not move.
- Values that look like spreadsheet formulas stay text in a text column; another column type casts each
  value and may refuse it.

---

**Sources:** [`CHANGELOG.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/CHANGELOG.md) (1.9.0, 1.12.0, and 1.13.0),
[`SECURITY.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/SECURITY.md) (Bulk changes and import),
[`packages/database-core/src/changes.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/changes.ts) (`MAX_BULK_ROWS`, `IMPORT_MAX_*`),
[`apps/web/features/import/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/apps/web/features/import),
[`apps/web/features/writes/bulk-dialogs.tsx`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/features/writes/bulk-dialogs.tsx).
