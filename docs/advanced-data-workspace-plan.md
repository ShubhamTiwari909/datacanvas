# Plan: the advanced data workspace

Status: **planned, not started. The twelve decisions of section 13 were settled on 2026-11-20: every recommendation was accepted (two releases, 1.8.0 then 1.9.0).** This is "Phase 4" of the roadmap: CSV import and export, bulk editing, advanced filters, a JSON editor and data validation. It builds on the data viewer (`docs/data-viewer-plan.md`, 1.2.0), sorting and filtering (`docs/data-sort-filter-plan.md`, 1.3.0), row and table editing (`docs/data-editing-plan.md`, 1.4.0), the SQL tab (`docs/sql-workspace-plan.md`, 1.6.0) and the Migrations tab (`docs/migration-studio-plan.md`, 1.7.0). It is the first work since 1.4.0 that **moves many rows at once**, in both directions, so it is the riskiest of the phases: the plan is organized around what could go wrong.

## 1. What we promise

For a table you may read (and, where writes are unlocked, change), from inside DataCanvas:

1. **Export** the rows you are looking at (all of them, with the filter and the sort you chose) as CSV, TSV, JSON or NDJSON.
2. **Import** a CSV file into a table you may write to: map its columns, see what is wrong **before anything is written**, and then insert it in one transaction, all or nothing.
3. **Edit many rows at once**: select rows and set a column, delete them, or edit several cells and apply them together, each row still checked against what you saw.
4. **Filter with more than "all of these"**: groups with OR, more operators (in a list, between, ends with, matches a pattern, JSON and array operators), date shortcuts, and "filter by this cell".
5. **Edit JSON** in a real editor: formatted, validated as you type, with a tree for large documents.
6. **Know a value is valid before it is written**: every form, import and bulk edit can be **validated** against the table (types, NOT NULL, CHECK, domains, uniqueness, foreign keys) without writing a row, and each failure says which row and which column.

What we do not promise: undo (a committed change is committed), spreadsheets (`.xlsx`), or a streaming ETL tool. Rows move one file at a time, with limits.

## 2. What we already have (and reuse)

- **Reading rows** (1.2 and 1.3): one page at a time, keyset paging by the key, a sort, up to three AND-ed conditions, masked columns (a hidden column can be neither sorted nor filtered: that would be an oracle), the data-access gate per connection, limits on page size and response size, and rows that are never logged, saved or put in an error. The column kinds (`text`, `ordered`, `other`) and the operator table live in `database-core/src/rows.ts`.
- **Writing rows** (1.4): `update_row`, `insert_row` and `delete_row` operations, a strict schema (no `sql` or `where` anywhere), the three layers (started with `--enable-writes`, a local database, unlocked by typing its name), preview then apply with a single-use id, one transaction that must affect exactly the rows it says, `lock_timeout`, no `CASCADE`, values cast in the database to the column's type, and **fixed error text by SQLSTATE** (never a database message, which can hold a value).
- **The SQL tab's machinery** (1.6): a connection of its own per run, a cursor read in small batches with a byte budget, one deadline, cancel that really cancels, and CSV, TSV and JSON export of a result **with a leading apostrophe on a value a spreadsheet would run as a formula**.
- **A lazy Monaco editor** (1.6) with a curated import list, and the layout of the Data section and the dialogs of the writes feature.
- **A shared grid keyboard hook** (1.7.1), which row selection builds on.
- **The migration tab's plan of what may fail** (1.7): "set NOT NULL", "add a unique constraint" and "add a foreign key" are marked `may_fail`. Validation can tell the person whether they **will** fail on this data (section 6.3).

## 3. The design in one page

| Feature          | Where the work happens                                                                      | New route                                 | Needs writes unlocked |
| ---------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------- |
| Advanced filters | Browser builds a filter tree; the server turns it into one `WHERE` from the catalog         | none (the rows route takes a bigger body) | no                    |
| JSON editor      | Browser only; saving is the existing `update_row`                                           | none                                      | to save               |
| Export           | Server reads the filtered rows through a cursor and streams text to the browser             | `POST .../rows/export`                    | no (data viewing on)  |
| Validation       | Server checks rows in a **temporary table**, never in the real one                          | `POST .../rows/validate`                  | **no** (read-only)    |
| Bulk edit        | New operations `update_rows` and `delete_rows` through the existing write path              | none (the write route's operation union)  | yes                   |
| Import           | Browser parses the file; the server gets a typed matrix; insert in batches, one transaction | none (a new operation `insert_rows`)      | yes                   |

Two rules hold throughout:

- **The browser parses, the server writes.** A CSV file is read in the browser (no parser of untrusted files on the server), turned into a matrix of strings, and sent as an operation like any other. Column names in the file are never used as identifiers: the person maps each file column to a catalog column.
- **Nothing here is SQL typed by the person.** Filters, exports and bulk edits are structured values the server turns into statements from catalog-checked names and bound parameters, as in sections 4 and 6 of the earlier plans.

## 4. Advanced filters

**Today:** up to three conditions joined by AND; operators `eq, neq, gt, gte, lt, lte, is_null, is_not_null`, plus `contains` and `starts_with` for text.

**New:**

- **A tree, not a list.** A group is `all of` or `any of`, holding conditions and at most one level of sub-groups (so "A and (B or C)", not deeper). At most **10 conditions** in all (from 3). The schema is strict at every level; a cursor and a sort work as before because they only change `ORDER BY` and the keyset condition.
- **More operators** (the kind decides which appear):

| Kind         | Added                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text         | ends with, does not contain, matches a pattern (`~*`, with the value bound), is empty                                                                                                                           |
| ordered      | in a list (up to 50 values), not in a list, between (inclusive), and for dates and times **today, last 7 days, last 30 days, this month** (computed in the database from `now()` in the connection's time zone) |
| json / jsonb | has the key (`?`), contains (`@>`, the value parsed as JSON in the database), the value at a path equals (`#>>` with the path as a bound text array)                                                            |
| array        | contains (`@>`), overlaps (`&&`), is empty                                                                                                                                                                      |
| other        | is null, is not null (unchanged)                                                                                                                                                                                |

- **Filter by this cell**: a button on a cell of a text or ordered column adds `column = value` (the value is the row's own and becomes a filter value like a typed one).
- **Saved filters** are kept per table in the browser, **without their values** (the rule that a condition's value is never saved stays). A saved filter is a shape ("status is ?, created is in the last 7 days") the person fills in again.
- **Costs and safety.** The 5-second read timeout and one read at a time per connection stay. A pattern is a POSIX regular expression that PostgreSQL runs; a pathological one is stopped by the timeout, and the page says so. A hidden column still cannot be filtered, and `matches a pattern` is refused on a column that was not revealed for the same reason (an oracle).

## 5. The JSON editor

**Today:** a `json` or `jsonb` cell is edited as plain text in a field, validated with `JSON.parse`.

**New:** a dialog (opened from the cell, the edit form and the insert form) with:

- an editor with **syntax colours, brackets that match, line numbers and the position of an error** ("line 4, column 12: expected a comma"), built on the lazy Monaco we already ship with a small hand-written tokenizer, not Monaco's JSON language service (which needs a web worker and adds hundreds of KB; decision 142's rule that the editor loads only when needed stays);
- **Format** (2-space) and **Minify**, a **tree view** for a large document (collapsed objects, long strings cut, the path shown and copyable), and a **diff** against the value that was loaded;
- the limits that already exist: values are read cut to 1,024 characters in the grid and read whole (up to a size cap, 1 MB for editing) when the dialog opens; a larger document is read-only with a message.

Saving is the existing `update_row` with the conflict check (`expected`). For `jsonb` the comparison is `IS NOT DISTINCT FROM CAST($ AS jsonb)`, which ignores key order and spacing, so a re-formatted document is not a conflict. A `json` column (which keeps the text) compares as text.

## 6. Data validation

Three levels, each cheaper and safer than writing and seeing.

### 6.1 In the browser

Per type, as the forms already do (numbers, dates, UUIDs, JSON, booleans, enum labels from the catalog, length of `varchar(n)`), plus the `NOT NULL` and default knowledge from the catalog. Instant and convenient; never the authority.

### 6.2 In the database, without writing: a temporary table

`POST .../rows/validate` takes the same operation as a write (an insert of rows, an update's new values, an import) and answers "would this be accepted?" **without touching the table**:

1. In a read-write transaction that is **always rolled back**: `CREATE TEMP TABLE v (LIKE target INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED INCLUDING INDEXES)`.
2. `INSERT` the rows into `v`, in batches. The database checks **types, domains, `NOT NULL`, `CHECK` and uniqueness inside the batch**. A temporary table carries **no triggers and no foreign keys**, so nothing a trigger would do (a `dblink` call, a `NOTIFY`, a write to another table) happens, and a validation can never change data.
3. **Uniqueness against the existing rows** and **foreign keys** are checked by read-only queries built from the catalog: for each unique index, rows of `v` whose key already exists in the target; for each foreign key, rows of `v` with no match in the referenced table.
4. The answer is a **report**, never values: for each rule (a column's type, a constraint by name), how many rows fail and the **row numbers** of the first 20, with fixed text by SQLSTATE and the constraint or column name (structure, not values).

Why a temporary table and not "insert, then roll back": a trigger runs on the real table, and a rolled-back transaction does not undo a call to another database or a program. The cost is that triggers and row-level security are **not** exercised by a validation; the report says so ("triggers on this table will run when you apply, and are not part of this check"), as the write preview already names them.

### 6.3 Pre-flight for a migration

The Migrations tab marks steps `may_fail` (`SET NOT NULL`, a unique constraint, a foreign key, a `CHECK`, a narrowing type change). When the **To** side is the same connection's live database (so the data is the data the migration will meet), a **Check against the data** button runs read-only counts built from the structure (not from typed text): rows with NULL in the column, groups of duplicate keys, rows with no parent, and, for a `CHECK` whose text comes from the structure, the number of rows that violate it, using the SQL tab's read-only pipeline (a read-only transaction, the cursor, the deadline). It answers "will step 7 fail?" with a number before the person runs the file. (The text of a `CHECK` comes from a definition read from a database; the check runs it only on the connection it was read from, read-only, and says so.)

## 7. Bulk editing

**Operations** (added to the write path of 1.4, same layers, same preview-then-apply, one transaction):

| Operation     | Meaning                                                                                                                      | Limit                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `update_rows` | the same column values set on a list of rows, each found by its key, each with the `expected` values it showed               | 500 rows                   |
| `edit_cells`  | several cells of several rows, each cell its own new value, each row its own `expected` (the "edit like a spreadsheet" case) | 500 rows, 50 cells per row |
| `delete_rows` | a list of rows by key, after a confirmation that shows the count and what references them                                    | 500 rows                   |

- **The conflict check stays per row.** A row that changed since it was loaded is **reported and skipped before anything is written**: the preview lists "3 of 120 rows changed since you loaded them" and the person decides (apply to the rest, or reload). The apply asserts `affected = number previewed` and rolls back otherwise.
- **Selecting.** Checkboxes in the grid (a row, a page, with shift-click for a range), a count in the toolbar, the keyboard model of the shared grid hook. Selection is by key and lives in memory; changing the filter or the page keeps it, changing the table clears it. **"Select all rows matching the filter" is not in the first version** (decision 13.4).
- **The editing grid.** Cells become editable in place (the same typed fields as the form), edited cells are marked, **Review changes** opens the diff (before and after per cell, columns named, values shown on screen only), and **Validate** runs section 6.2 on the new values.
- **What the person is told**, as for one row, but counted: triggers that will run **for each row**, foreign keys that cascade (with how many rows they would reach where it can be counted), row-level security that may hide rows.
- **Keyless tables** stay read-only. A column of a kind with no text editing (`bytea`) stays read-only.

## 8. Export

- **What:** the rows of the table or view **as filtered and sorted on screen**, in the columns shown. **Masked columns are left out unless revealed**, and the file says which were left out. Formats: **CSV, TSV, JSON, NDJSON**. A value a spreadsheet would run as a formula gets the same leading apostrophe as in the SQL export; a header row, a delimiter choice (comma, semicolon, tab), NULL written as an empty field or as a word of the person's choice (empty string stays empty).
- **How:** `POST .../rows/export` with the table, the filter tree, the sort and the format. The server builds the statement from the catalog as the viewer does, opens a read-only transaction and a **cursor** (so a table without a key and a consistent snapshot both work), reads in batches of 1,000, and writes the text to the response as it goes. The browser saves it as a file (no file path on the server, nothing kept). **Limits:** 100,000 rows and 64 MB by default (decision 13.2), one export at a time per connection, one deadline, a progress count, and **Cancel** (an abort cancels the cursor in the database, as in the SQL tab).
- **What the file says at the top** (for formats that can hold a comment; a `.json` gets a `_meta` sibling only in NDJSON's first line if asked): where it came from, when, the filter in words, how many rows, and whether it was cut at a limit.
- **Privacy:** a file of rows is what the person asked for. Like the SQL export it is made on their machine from rows they could already see, and nothing about it is saved, logged or cached by DataCanvas.

## 9. Import

**The flow** (a dialog from the Data section, only when writes are unlocked):

1. **Choose a CSV file** (up to 20 MB, UTF-8 with or without a BOM; other encodings are refused with a message, not guessed). Parse it **in the browser**: delimiter detected (comma, semicolon, tab, pipe) with an override, quotes and escaped quotes, line breaks inside quotes, a header row or not.
2. **Map columns.** Each file column is mapped to a column of the table, or ignored. Required columns (`NOT NULL` with no default) that are not mapped are flagged. The person says how a field is read: **an empty field is NULL**, or is the empty string, or a word the person names is NULL ("NULL", "\\N", "n/a"). A preview shows the first 10 rows as they will be read, typed.
3. **Validate** (section 6.2): the whole file, on the server, in the temporary table, without writing. The report: how many rows pass, and for each rule that fails the count and the first 20 row numbers (the file's row numbers, counting the header). Nothing about a value is echoed. The person fixes the file and tries again, or chooses to **skip the rows that fail** (decision 13.3), which writes a **rejects file** of the skipped rows on their machine.
4. **Preview and apply**, with the layers of 1.4: a summary ("insert 48,210 rows into `public.orders`; triggers on this table will run for each row; 2 foreign keys will be checked"), a single-use preview id held in memory with an expiry, then the insert: batches of 500 rows as one multi-row `INSERT` with bound parameters (each value cast to its column's type), **one transaction**, `lock_timeout` as before, a raised `statement_timeout` for the whole import, `affected = rows previewed` asserted, rolled back on any error. A progress bar and **Cancel** (rolls back).

**Limits:** 100,000 rows, 50 columns, 20 MB, 10,000 characters per cell; one import at a time per connection. **Insert only** in the first version (no update by key, no upsert; decision 13.3).

**What the server holds:** the parsed rows are in the request body and in the preview store's memory until the apply or the expiry (5 minutes), not on disk, and are dropped on disconnect, exactly as a row edit's values are today.

**Speed:** a batched, parameterized `INSERT` is slower than `COPY`, and `COPY ... FROM STDIN` needs a new dependency and a second code path through the write layer. The first milestone **measures** both on 100,000 rows before choosing (section 11, D0); the recommendation is batched `INSERT` unless it is more than about five times slower, because it reuses every guard the write path already has.

## 10. Security and privacy

This phase changes three promises, and the README, `SECURITY.md`, the threat model and the in-app wording change **with it** (section 12).

| Promise today                                       | After                                                                                                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No bulk operations; no import of CSV or JSON        | **Changes, narrowly:** bounded bulk operations (500 rows) and an import (100,000 rows), only with writes unlocked, only on a local database, only with data viewing on, each previewed and applied once. |
| Rows leave only on screen                           | **Changes:** an export puts the rows the person can see into a file they asked for. Masked columns are left out unless revealed; formulas are defused.                                                   |
| A hidden column cannot be filtered                  | **Stays,** and extends to the new operators (a pattern on a hidden column is the same oracle).                                                                                                           |
| Values are never logged, saved, cached or in errors | **Stays:** a validation report and an import's errors carry row numbers, column and constraint names and counts, never values.                                                                           |
| Nothing a person types is SQL                       | **Stays:** filters, bulk edits, exports and imports are structured operations; every name comes from the catalog; every value is bound.                                                                  |

| Attempt                                                      | Control                                                                                                                                                                 | Residual                                                                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A web page or program with the token imports or bulk-deletes | The same Host, Origin, `Sec-Fetch-Site` and token checks; **`--enable-writes` is not in the API**; the unlock needs the database name; the operations need a preview id | Someone holding the token **and** an unlocked connection can write (as since 1.4.0)                                            |
| A hostile CSV                                                | Parsed in the browser; column names never used as identifiers; every value bound and cast by the database; size, row and cell limits; UTF-8 only                        | A file that is valid and wrong inserts valid wrong rows: validate, preview and the count are the defence                       |
| A hostile table name, column name or type in the database    | Every name from the catalog, quoted; the temporary table is created with `LIKE`, so no name is concatenated from the file                                               | None known                                                                                                                     |
| Validation having side effects                               | A temporary table has no triggers and no foreign keys; the transaction is always rolled back; the real table is only read                                               | A function in a `CHECK` or a default that has effects outside the database runs (the role is the control; the preview says so) |
| A pattern that never finishes (`matches a pattern`)          | 5-second read timeout, one read at a time, cancel                                                                                                                       | Up to 5 seconds of CPU per try                                                                                                 |
| Taking the server down with an export or an import           | Row, byte and time limits, a cursor read in batches, one at a time per connection, cancel that cancels in the database                                                  | One export or import can use the server for its limits                                                                         |
| Rows in an export that should have been masked               | Masked columns excluded unless revealed, and the file says which                                                                                                        | A column the person revealed (their choice), and a name that does not look sensitive but is                                    |
| A formula in an exported file                                | The leading apostrophe of the SQL export, for every format that a spreadsheet opens                                                                                     | A spreadsheet that ignores it                                                                                                  |
| A bulk update that hits more than the person saw             | Keys, not conditions; `expected` per row; `affected = previewed` or rollback; a count in the confirmation                                                               | None known                                                                                                                     |
| Triggers firing for every row of a bulk edit or an import    | The preview names the triggers and says "for each row"                                                                                                                  | A trigger does what its code does                                                                                              |

An **independent review** of the write side (bulk edit and import) and the validation (the temporary table and its read-only queries) happens before that part is released, as for 1.5.2, 1.6.0 and 1.7.0, each of which found real high-severity bugs.

## 11. Milestones

Each is red-first, ends with every check green, and is a commit on one branch. **Decision 13.1 is whether this is one release or two**; the recommendation is two, because the first has no new way to write and the second does.

|     | Milestone                         | Done when                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D0  | **Spikes**                        | (a) `INSERT` batches against `COPY` on 100,000 rows, measured; (b) the temporary-table validation on PostgreSQL 12 to 18 (domains, generated columns, partitioned targets, identity); (c) a hand-written JSON tokenizer in the lazy Monaco; (d) memory of a streamed export of 100,000 rows. Decisions recorded.                                   |
| D1  | **Filter tree and new operators** | Core type and strict schema, the statement builder, the operators of section 4, tests against a real PostgreSQL for each (hostile values, `NULL`, empty list, a pattern that fails to compile), the oracle rule for hidden columns; the panel UI with groups, "filter by this cell" and saved shapes; e2e; axe, dark, phone                        |
| D2  | **JSON editor**                   | The dialog with the tokenizer, format, minify, tree, diff, error position; the size cap; `jsonb` and `json` conflict checks; used from the cell, the edit form and the insert form; e2e; axe, dark, phone                                                                                                                                          |
| D3  | **Validation**                    | The temporary-table check and the read-only uniqueness and foreign-key queries, the report with row numbers and no values, the route, tests for every rule and for "never a trigger, never the real table", wired into the single-row edit and insert forms ("Validate" beside "Preview"), and the pre-flight of section 6.3 in the Migrations tab |
| D4  | **Export**                        | The route and the cursor, the four formats, masking, defusing, the limits and cancel, the dialog with progress; tests with hostile values and with a table of 100,000 rows; e2e that reads the file. **Release 1.8.0 here** if decision 13.1 is "two": independent review of the validation first                                                  |
| D5  | **Bulk editing**                  | Selection in the grid, `update_rows`, `edit_cells`, `delete_rows` through the write path, per-row conflicts reported before writing, the review diff, validation, tests (conflict, limits, triggers named, rollback on a count mismatch), e2e                                                                                                      |
| D6  | **Import**                        | The browser parser (delimiters, quotes, line breaks, BOM, header), the mapping screen, the validation of the whole file, the `insert_rows` operation in batches in one transaction, progress and cancel, the rejects file; tests with hostile files and a 100,000-row file; e2e                                                                    |
| D7  | **Polish, docs, review, release** | README, the guide, `SECURITY.md`, the threat model, decisions, CHANGELOG; the independent review of the write side (D5 and D6); fixes; version; a PR. **Release 1.9.0 here** if "two"                                                                                                                                                              |

Rough size: D0 2 days, D1 4, D2 3, D3 4, D4 3, D5 4, D6 5, D7 3. About 28 days, most of it in D3, D5 and D6, because the tests are the work.

## 12. Documentation to update (in the same change)

README (the feature list and the sentence about what DataCanvas never does), `docs/getting-started.md` (a chapter on filters and export, one on import and bulk edit), `SECURITY.md` (a section for export, import and bulk operations, and the new known limits), `docs/threat-model.md` (sections for each, and one for the review), `docs/decisions.md`, `CHANGELOG.md`, the CLI help if a flag or limit appears, and the wording in the unlock dialog ("you can now change many rows at once").

## 13. Decisions taken (2026-11-20): every recommendation accepted

1. **One release or two?** _Recommend two:_ **1.8.0** = filters, JSON editor, validation, export (nothing in it writes a row), **1.9.0** = bulk editing and import (the write side, with its own review).
2. **Export limits.** _Recommend_ 100,000 rows and 64 MB by default, with the file saying when it was cut; no setting to raise it in the first version.
3. **Import behaviour.** _Recommend_ all or nothing in one transaction, **insert only**; "skip the rows that fail and write a rejects file" as an explicit choice after validation; upsert (`ON CONFLICT`) and update-by-key later.
4. **Bulk update scope.** _Recommend_ selected rows only (500 at most) in the first version; "all rows matching this filter" later, with the count typed to confirm.
5. **Validation scope.** _Recommend_ what the schema says (types, `NOT NULL`, `CHECK`, domains, uniqueness, foreign keys), plus the migration pre-flight; **no user-defined rules** (a rule language is its own product).
6. **JSON editor.** _Recommend_ the lazy Monaco with a hand-written tokenizer, our own validation and a tree; not Monaco's JSON service (worker and size).
7. **Saved filters.** _Recommend_ saving the shape (column and operator) and never the value.
8. **Pre-flight in the Migrations tab** (section 6.3, runs the text of a `CHECK` read-only on the connection it came from). _Recommend_ yes, in D3, because it answers the question the `may_fail` badge raises.
9. **Export formats.** _Recommend_ CSV, TSV, JSON and NDJSON; a script of `INSERT` statements later (it is another thing to quote correctly).
10. **Import files.** _Recommend_ CSV only, UTF-8 only, no Excel.
11. **`COPY` or batched `INSERT`.** _Recommend_ whichever D0 measures as fast enough with the fewer new paths: batched `INSERT` unless it is more than about five times slower.
12. **Where the validation reaches triggers.** _Recommend_ it never does (temporary table), and says so.

## 14. Risks of the project itself

| Risk                                                                               | Mitigation                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An import is slow or uses too much memory                                          | D0 measures; batches; limits; the body is a bounded matrix; the preview store caps its size                                                                                 |
| A validation says "fine" and the apply fails (triggers, row-level security, races) | The report says what it does not check; the apply is still all or nothing; the number of rows in the preview is asserted                                                    |
| A filter tree is too complex to use, or to build safely                            | Depth 2, 10 conditions, a strict schema, a builder that is a pure function with a table of tests; the panel shows the filter in words                                       |
| The write path grows and its guarantees thin out                                   | Bulk operations are variants of the same operation union, through the same service, the same layers, with an architecture test; the independent review reads the write side |
| Scope: five features, three of them large                                          | Two releases; the read side first; each milestone ends green                                                                                                                |

## 15. What D0 found (2026-11-20)

Spikes for 1.8.0. (The `COPY` against batched `INSERT` measurement belongs to 1.9.0 and is done at D5.)

**Validation in a temporary table** (`postgres.adapter.validation-spike.test.ts`, kept as tests so a PostgreSQL that changes a fact is noticed; the CI matrix runs them on PostgreSQL 12 to 18). The design of section 6.2 stands, with these corrections:

- `CREATE TEMP TABLE ... (LIKE target INCLUDING CONSTRAINTS INCLUDING GENERATED)` copies types, domains (so a domain's check applies), `NOT NULL`, `CHECK` and generated columns, and **no triggers and no foreign keys**. A trigger of the real table never fires.
- **`INCLUDING DEFAULTS` must not be used.** A copied default that calls a sequence advances the real sequence, and a rollback does not undo that (a measured gap in the numbering). The copy gets **no defaults and no indexes**, and **the `NOT NULL` of every column the database would fill itself (a default, an identity, a serial) is dropped**, because the row is not asked for what it will not give. (Found when an identity key made every row fail "null value in column id".)
- **Uniqueness is asked in queries, not by copied indexes**: duplicates inside the batch with `GROUP BY ... HAVING count(*) > 1` on the key columns the rows supply, collisions with existing rows with `EXISTS` on the real table. This also avoids demanding a key the database would generate.
- **What the error tells:** the SQLSTATE always; the column for `NOT NULL` (`23502`); the constraint for `CHECK` and domain checks (`23514`); **nothing** for a value that does not cast (`22P02`, `22003`). The column of such a failure is found by casting the failing row's cells one at a time, in a read-only `SELECT`, never by reading the message.
- **Failing rows are found by splitting the batch in halves** (savepoints): 4 bad rows in 20,000 took fewer than 200 statements, not 20,000. The first 20 failures are enough for a report, so the search stops there.

**The JSON editor** (`apps/web/features/json/json-text.ts`, 28 tests). Monaco's JSON support is its own language service with a web worker (`language/json`); the `basic-languages` list has no JSON. The editor will register a small Monarch tokenizer of its own with `setMonarchTokensProvider` from `editor.api`, which adds nothing to the bundle. Two things the spike settled:

- **Format must not go through `JSON.parse` and `JSON.stringify`**: they turn `12345678901234567890` into `12345678901234567000`. The text is tokenized strictly (RFC 8259) and re-written with other white space, so every number and string stays as written. A test pins it.
- **Our own checker, not `JSON.parse`'s message**: the message and its position differ between browsers. The checker reports the first error with a line and a column (counting `\r`, `\n` and `\r\n` as one break each), refuses a document nested more than 200 levels deep (a hostile one must not exhaust the stack), and says what was expected.

**Export** (`postgres.adapter.export-spike.test.ts`): 100,000 rows of six columns (30 MB of CSV, with a `jsonb` document and a 200-character note) read through `DECLARE ... NO SCROLL CURSOR` and `FETCH 1000` in a read-only transaction took **0.5 seconds**, and the heap grew by 38 MB (garbage between collections; it does not grow with the rows). The 64 MB default limit is reached at about 200,000 rows of this size, before the 100,000-row limit matters for wide tables, so both limits stay. Memory is not the constraint; the browser receiving the file is.

## 16. What D1 found (2026-11-20)

The filters of section 4 are built (core, schema, adapter, panel). Where the build differs from the plan:

- **Groups are numbers, not a tree.** A condition has an optional `group` (1 to 3): conditions with the same number are OR-ed, conditions without one are all required. That is "A and (B or C)" and "A or B" with one flat list, which fits the existing request, the cursor, the chips and the saved shapes without a second structure, and it is what the panel can show clearly (a "Combine" box on each condition). It cannot say "(A and B) or C" without repeating C in two groups; that case is left out, on purpose.
- **Ten conditions** (from three), at most 50 values in a list, a path of at most 10 steps.
- **Kinds.** `json` (json and jsonb) and `array` are kinds of their own now, so each is offered its own conditions; neither can be sorted. The date shortcuts are offered by the column's type (a date or a timestamp), and are written for that type so no time zone is guessed.
- **A value used twice is cast to text** (`length(CAST($1 AS text))`), so PostgreSQL never has to guess which `length` it means. A list of an array condition is cast into the column's own array type (`CAST(ARRAY[...] AS integer[])`), the type text coming from the catalog, never from the request.
- **A regular expression** (`matches`) is `~*` with the pattern bound; one that does not compile is a data exception and so the fixed `invalid_request`; one that never ends is stopped by the 5-second read timeout. A hidden column is refused for every new operator, as before.
- **Filter by this value** is a button in the dialog of a cell, for text and ordered columns (an equals, or a NULL test for NULL); a value that was cut or is over 200 characters offers none.
- **Saved shapes** are kept per table in local storage as `{name, conditions: [{column, op, group}]}`, read back as untrusted data, at most 20 per table, and using one opens a form that asks for the values again.
- **A neighbour found by axe on a phone:** the columns table of the Table details tab scrolled sideways without being reachable by the keyboard; it is a focusable region now.
