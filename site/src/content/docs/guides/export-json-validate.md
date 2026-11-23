---
title: Export, JSON editor, Validate
description: Export the rows you are looking at as a file, edit json and jsonb values with a tree and diff, and ask the database whether values would be accepted without writing a row.
---

All three need **Allow viewing table data** on for the connection.

## Export

The **Export** button in the Data section writes the rows you are looking at, **with the filter and sort
on screen**, to a file on your computer:

| Format     | Notes                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------- |
| **CSV**    | Starts with a byte order mark so a spreadsheet opens it as UTF-8; comma or semicolon delimiter. |
| **TSV**    | Tab-separated.                                                                                  |
| **JSON**   | An object with `rows` and `_meta`.                                                              |
| **NDJSON** | One object per line; a final `_meta` line when relevant.                                        |

- **Limits:** up to **100,000 rows** and **64 MB**. A longer table ends the file with a line that says it
  was cut (a `#` line in CSV/TSV, a `_meta` member in JSON, a last `_meta` line in NDJSON). **Cancel**
  stops the read in the database.
- **Sensitive-looking columns** are left out unless you showed them, and the notes at the end of the file
  name them.
- **NULL** is an empty field in CSV and TSV unless you give it a word; it is `null` in JSON.
- A value a spreadsheet would run as a formula starts with an apostrophe.
- One export runs at a time per connection (`export_busy`). Closing the dialog ends the read.
- The file is made on your machine from rows you could already see. DataCanvas keeps nothing of it, and
  cannot protect it after your browser saved it.

## JSON editor

A `json` or `jsonb` cell has **Open as JSON** in its dialog, and the edit and add-row forms have **Edit as
JSON** beside the field.

- Syntax colouring, and the **line and column** where the text stops being JSON.
- **Format** and **Minify** keep every number and string exactly as written (no round-trip through
  JavaScript numbers).
- A **Tree** view for a large document, with the path of any part (copyable).
- **Changes** compares with the loaded value.
- A value the grid cut short is read whole (up to **1 million characters**). A document over **100,000
  characters** can be read but not edited here.
- The editor writes nothing by itself: a changed value goes through the normal
  [preview and apply](/guides/editing/).

## Validate

In the edit and add-row forms, **Validate** asks the database whether it would accept the values and
**writes no row**.

- The values are checked in a **temporary copy** of the table (its types, NOT NULL, CHECK and generated
  columns, but no triggers, foreign keys, defaults or indexes) inside a transaction that is switched to
  read-only before the first value goes in and is always rolled back. Uniqueness and foreign keys are
  asked by read-only queries on the real tables.
- It names the rule that fails (NOT NULL, a CHECK, a value that does not fit the type, a unique key
  already taken, a missing parent) with column and constraint names, counts and row numbers, **never a
  value**.
- It says what it did not check: triggers, row-level security, partial and expression unique indexes,
  exclusion constraints, partition bounds and a key on a hidden column.
- It needs the right to create temporary tables. It takes up to 100,000 rows (so an import file is checked
  whole). It works on a connection that is not local and without the unlock, which on a remote database
  writes that much into a temporary table of your session.
- **Event triggers** in the database can still fire when the temporary copy is made, and can write (a
  sequence can advance). The report says when one exists. A function in a CHECK with effects outside the
  database (through an extension such as `dblink`) is not stopped by a read-only transaction or undone
  by the rollback. The role you connect with is the control.

See also [Security: writes, SQL and migrations](/security/risky-features/).

---

**Sources:** [`packages/database-core/src/rows-export.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/database-core/src/rows-export.ts),
[`packages/database-core/src/validation.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/database-core/src/validation.ts),
[`apps/web/features/json/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/features/json),
[`CHANGELOG.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/CHANGELOG.md) (1.8.0), [`SECURITY.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/SECURITY.md),
[`docs/getting-started.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/getting-started.md).
