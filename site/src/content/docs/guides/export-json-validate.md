---
title: Export, JSON editor, Validate
description: Export the rows you are looking at (or the rows you chose) as a file or an INSERT script, export the structure as documentation, edit json and jsonb values with a tree and diff, and ask the database whether values would be accepted without writing a row.
---

All three need **Allow viewing table data** on for the connection. (The [documentation export](#export-documentation-structure-only) below does not: it reads no rows.)

## Export

The **Export** button in the Data section writes the rows you are looking at, **with the filter and sort
on screen**, to a file on your computer:

| Format                             | Notes                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| **CSV**                            | Starts with a byte order mark so a spreadsheet opens it as UTF-8; comma or semicolon delimiter. |
| **TSV**                            | Tab-separated.                                                                                  |
| **JSON**                           | An object with `rows` and `_meta`.                                                              |
| **NDJSON**                         | One object per line; a final `_meta` line when relevant.                                        |
| **SQL INSERT statements** (1.10.0) | A script you run yourself; see [below](#a-script-of-insert-statements).                         |

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

### Export only the rows you chose (1.10.0)

Every grid of a table **with a key** has a checkbox on each row (a click with Shift chooses a range, the
header's box chooses the page). It no longer needs writes to be unlocked. With rows chosen, **Export
chosen** writes just those rows, in any of the formats above.

- **Up to 500 rows.** The grid says "(the most for one export)" when you reach the limit.
- The server **reads the chosen rows again by their keys** (each by the table's whole key), with the same
  rules as any export: sensitive-looking columns are left out unless shown, a value is read whole, and the
  data-access check comes first. It is not what the grid held in memory.
- **Refused:** a table without a key, a key that is not the table's key, and a key column that looks
  sensitive and was not shown.
- The notes of the file say **how many** rows were chosen, never their keys.
- The request body may be up to 4 MB for chosen rows (a composite key of two uuids over 500 rows is about
  66 KB, which the default 64 KB limit refused before 1.10.0).

### A script of INSERT statements

The **SQL INSERT statements** format (1.10.0) writes a script for a test copy of the table:

- `BEGIN;` ... `COMMIT;`, **one transaction**, with every **value a quoted text literal** and every name
  quoted, 100 rows to a statement.
- **Generated columns are left out** (an `INSERT` cannot set them); **identity columns are kept**, with
  `OVERRIDING SYSTEM VALUE` for `GENERATED ALWAYS`. The script says that identity sequences are not moved:
  set them with `setval()` if rows are added later.
- The script starts with `SET LOCAL` for `standard_conforming_strings`, `datestyle` (`ISO, MDY`) and
  `intervalstyle` (`postgres`), so the settings end with the transaction and your session is as it was, and
  a recipient with another `DateStyle` cannot read April 3 as March 4.
- **A half script commits nothing.** A script that was cut ends with `ROLLBACK;` instead of `COMMIT;`; one
  made with sensitive-named columns left out also ends with `ROLLBACK;` (it is not a copy of the table);
  one that failed has no end at all, so its `BEGIN;` is never committed.
- **Run it in an empty copy of the table**: it inserts, it does not replace. DataCanvas does not run it.
  It was proved by a round trip against a real PostgreSQL.

## Export documentation (structure only)

**Export documentation** (1.10.0) writes the structure of the **whole database or one schema** as a file you
can keep, paste or commit. It is a button on the **Overview** tab and an entry in the canvas **Export**
dialog.

| Format                       | For                                                        |
| ---------------------------- | ---------------------------------------------------------- |
| **Markdown data dictionary** | A document: tables, columns, keys, indexes and references. |
| **Mermaid**                  | An `erDiagram` for GitHub, GitLab and Mermaid Live.        |
| **DBML**                     | dbdiagram.io and other DBML tools.                         |
| **PlantUML**                 | An entity-relationship diagram for PlantUML.               |

- It is **made in your browser from structure DataCanvas already reads** (names, types, keys, indexes).
  **No row of any table is read**, it needs no **Allow viewing table data**, and nothing is uploaded.
- The Markdown file and DBML also carry **column defaults, check rules and comments**, which can hold a
  literal. The dialog says what the file holds before it is made.
- **Every name is quoted for its format**, so a table or column name cannot become syntax (a comment
  cannot change the structure of the Markdown; a name is not a link; PlantUML and Mermaid names hold nothing
  their parsers could read as a directive).
- At most **5,000 tables** in one file; a larger database is documented a schema at a time.
- The names can reveal how your system works: **check where you paste a text diagram**.

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

**Sources:** [`apps/web/features/docs/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/features/docs) (`docs-export-dialog.tsx`, `generate.ts`, `markdown.ts`, `mermaid.ts`, `dbml.ts`, `plantuml.ts`),
[`apps/web/app/api/connections/[id]/rows/export/route.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/app/api/connections/%5Bid%5D/rows/export/route.ts),
[`packages/shared-types/src/connections.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/shared-types/src/connections.ts) (`exportRequestSchema`, `EXPORT_MAX_BODY_BYTES`),
[`packages/database-core/src/rows-export.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/database-core/src/rows-export.ts),
[`packages/database-core/src/validation.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/database-core/src/validation.ts),
[`apps/web/features/json/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/features/json),
[`CHANGELOG.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/CHANGELOG.md) (1.8.0, 1.10.0), [`SECURITY.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/SECURITY.md),
[`docs/getting-started.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/getting-started.md).
