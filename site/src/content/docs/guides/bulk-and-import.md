---
title: Bulk edit and CSV import
description: Change up to 500 rows together or import a CSV file of up to 100,000 rows, all through a preview and in a single all-or-nothing transaction.
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

## Import a CSV file

**Import CSV** (in the Data section) reads a file from your computer. It is read **in your browser** and
is not uploaded as a file; the server never parses it.

| Limit      | Value                                                   |
| ---------- | ------------------------------------------------------- |
| Rows       | 100,000                                                 |
| Columns    | 50                                                      |
| File size  | 20 MB (about 32 MB as the JSON request)                 |
| One cell   | 10,000 characters                                       |
| Encoding   | UTF-8                                                   |
| Delimiters | comma, semicolon, tab or pipe, with or without a header |

Steps:

1. **Choose a column of the table** for each column of the file, or leave it out. A name in the file is
   **never used as a name in a statement**; you map file columns to table columns.
2. Say whether an empty field is NULL or an empty string, and which words (for example `NULL`) also mean
   NULL.
3. **Validate the file**: the database checks every row against the table's rules without writing, and
   names the rows of the file that fail. Columns the table needs that the file does not give are named
   before you can preview.
4. **Preview the import**: the statement and how many batches it takes.
5. **Apply** adds every row in **one transaction**, in batches of 500. If any row fails, **none** is added.
   **Cancel and roll back** stops it; closing the dialog or losing the connection also rolls back.

To skip bad rows, fix the file and try again.

## Things to know

- The statement is one fixed shape, `INSERT … SELECT CAST(…) FROM unnest(…)`, whose names come from the
  catalog and whose values are bound.
- An import or bulk change fires the table's **row-level triggers once per row** (and statement-level
  triggers once per statement, so once per batch of up to 500 rows for an import).
- A committed import is **not undone** by DataCanvas. When it matters, try the file on a test copy first.
- An import with values for an identity column warns that the sequence does not move.
- Values that look like spreadsheet formulas stay text in a text column; another column type casts each
  value and may refuse it.

---

**Sources:** [`CHANGELOG.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/CHANGELOG.md) (1.9.0),
[`SECURITY.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/SECURITY.md) (Bulk changes and import),
[`packages/database-core/src/changes.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/database-core/src/changes.ts) (`MAX_BULK_ROWS`, `IMPORT_MAX_*`),
[`apps/web/features/import/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/features/import),
[`apps/web/features/writes/bulk-dialogs.tsx`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/features/writes/bulk-dialogs.tsx).
