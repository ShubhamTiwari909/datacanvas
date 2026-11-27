# Plan: 1.12.0, the write side, second part (import and bulk editing, finished)

Status: **built as 1.12.0 (2026-11-27), except the progress stream (4.5, decision 4) and paste from a spreadsheet (section 5), which were not built;** moved to 1.12.0 on 2026-11-24: the MCP server (`docs/mcp-server-plan.md`) is built first as 1.11.0, and nothing in this plan changes.** Originally proposed 2026-11-23; the decisions of section 11 were taken by the owner on 2026-11-23 (every recommendation accepted, decision 162).** It finishes what 1.9.0 deliberately left out (`docs/advanced-data-workspace-plan.md`, sections 19 and 20; decisions 159 and 160). It follows `docs/insight-release-plan.md` (1.10.0, nothing in it writes) and `docs/mcp-server-plan.md` (1.11.0, nothing in it writes) and, like 1.9.0, **ends with its own independent review of the write side**, because every item here changes data in a way the earlier releases did not.

## 1. What we promise

1. **Update or insert on import**: a file whose rows already exist in the table updates them, and the rest are added, by a key the person chooses from the table's own unique constraints. An **update only** mode (the rows must exist) for corrections.
2. **Import the valid rows and keep the rest**: after the whole-file validation, "leave out the failing rows and import the others", with a **rejects file** (the failing rows and the reason, made in the browser) to fix and import again. This is the choice decision 153 promised and 1.9.0 did not build (decision 160).
3. **Other encodings**: the person can choose Windows-1252 / Latin-1 or UTF-16 when a file is refused as not UTF-8.
4. ~~**A progress bar** for an import, from the batches the server has finished, instead of a spinner.~~ **Not built in 1.12.0** (see 4.5 and decision 4 of section 11).
5. **Bulk change of "all the rows this filter matches"**: set a value on, or delete, every row of the filter, up to 100,000, after the exact count is shown and **typed to confirm**.
6. **Edit cells in the grid**: double-click a cell, change it, and review all the pending changes together (the editing grid and `edit_cells` that 1.9.0 deferred), with each row checked against what the person saw.
7. **Edit a cut text value** (over the grid's 2,000 characters, up to the 100,000 a change can carry): the whole value is read for the form, as the JSON editor reads a `jsonb`.

What we do not promise: undo (a committed change is committed), editing `bytea` (a binary editor is a product of its own; it stays read-only with a hex view planned separately), a `WHERE` typed by a person (never), or `COPY`.

## 2. What we already have (and reuse)

- **The write path** (1.4 to 1.9): structured operations in a strict schema (no `sql`, no `where`), the three layers (started with `--enable-writes`, a local database, unlocked by typing the database name), preview in a read-only transaction, a single-use preview id, apply in one transaction with a plan guard and `expect: "one_row"` or `expectRows`, fixed errors by SQLSTATE, a history without values.
- **`insert_rows`** (1.9.0): batches of 500 of one fixed `INSERT ... SELECT CAST(...) FROM unnest(arrays)`, every identifier from the catalog, every value bound, each batch checked for the rows it added, a cancel between batches.
- **`update_rows` and `delete_rows`** (1.9.0): one single-row statement per row, found by the table's whole key, conflicts found at preview (`skipped`), all or nothing.
- **Validation of a whole file** (1.8.0, raised in 1.9.0): a temporary copy, uniqueness and foreign keys by read-only queries, row numbers and rule names, never a value; it lists 20 failing rows and counts up to 100.
- **The browser's CSV parser and the mapping screen** (1.9.0), the selection of rows by key, the `edit-info` read (which columns can be written, the key, the triggers).
- **The page reader's condition builder** (1.8.0): the filter is checked against the catalog and every value is bound. It is used by reads only; nothing writes through it, and section 6 keeps it so.

## 3. The design in one page

| Feature                    | Where the work happens                                                                                                                    | New operation or route               | New statement shape                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Update or insert           | The `insert_rows` batch with `ON CONFLICT (key) DO UPDATE`, the key from a unique constraint of the catalog                               | `upsert_rows` (an operation)         | **Yes:** the `ON CONFLICT` clause on the existing batch statement       |
| Update only (by key)       | One `UPDATE ... FROM unnest(keys, values)` per batch, joined on the key                                                                   | `update_by_key` (an operation)       | **Yes:** the `UPDATE ... FROM unnest` batch                             |
| Leave out the failing rows | Browser: the report names the rows; the browser removes them and writes the rejects file; the server runs the usual all-or-nothing import | none                                 | none                                                                    |
| Other encodings            | Browser only (`TextDecoder`)                                                                                                              | none                                 | none                                                                    |
| Progress (not built)       | The apply answer of an import becomes a stream of batch counts, then the result (**dropped, see 4.5**)                                    | none in 1.12.0                       | none                                                                    |
| All rows of a filter       | **The keys are found at preview** by the page reader's read; apply updates or deletes **those keys** with the batch statement above       | `update_matching`, `delete_matching` | none beyond the keyed batch of `update_by_key` and a keyed delete batch |
| Edit cells                 | One `UPDATE` per row with its own columns and its own `expected`, by the builders of a single row                                         | `edit_cells` (an operation)          | none                                                                    |
| Edit a cut text value      | `getCell` reads a whole `text` value (as it reads a `json`)                                                                               | `rows/cell` accepts text columns     | none                                                                    |

The three rules of 1.9.0 hold, and one is added:

- **The browser parses, the server writes.** The server never parses a file.
- **Every identifier from the catalog, every value bound**, no `CASCADE`, errors from SQLSTATE, no value in a preview, a history entry, a log or `skipped`.
- **All or nothing, and the count the person saw is the count that is checked.** Each new operation names the number of rows it expects; any other number rolls everything back.
- **New: a write statement is never built from the person's conditions.** A filter reaches the database only in the read of the preview. What is written is a list of keys that the preview found and the server holds (section 6).

## 4. Import, finished

### 4.1 Update or insert (`upsert_rows`)

- The person picks **the key** from a list of the table's own unique and primary-key constraints (never partial indexes or expression indexes: `ON CONFLICT` needs an inferable target, and a partial one needs a predicate). **Every column of the key must be `NOT NULL`** (a primary key always is): `NULL` never matches `=` and never conflicts, so a nullable unique constraint would insert duplicates in an upsert and match nothing in an update; a constraint with a nullable column is not offered (and `NULLS NOT DISTINCT`, PostgreSQL 15 and later, is left for later). The columns of the key must all be mapped. The server turns the choice into `ON CONFLICT ("a", "b")` with the names from the catalog and **re-checks that these columns are a unique constraint** at preview, so a request cannot name any other.
- Which columns are **updated** when the key exists is a choice (the mapped columns that are not the key; default all of them): `DO UPDATE SET "c" = EXCLUDED."c"`, again from the catalog's names. A choice of **none** is "leave existing rows alone" (`DO NOTHING`), which is the cheapest way to import only what is new.
- **The preview counts, before anything is written**, how many rows of the file already exist (by the key, one read-only join of the file's keys against the table: how many would be inserted, how many updated) and says it in the first line. An update of existing rows is a change of existing data: **it needs the tick** that a delete needs, and says "N rows will be overwritten".
- **Two rows of the file with the same key** make `ON CONFLICT DO UPDATE` fail ("cannot affect row a second time"). The validation of the file finds them (uniqueness inside the batch is already one of its rules) and the preview refuses a file that has them, naming the rows.
- **The count check.** With `DO UPDATE` every row is inserted or updated, so a batch of N rows must report N; with `DO NOTHING` it reports the rows that were new and the preview's count says how many that must be. Either way a different number rolls everything back. The result tells how many were inserted and how many updated (`RETURNING (xmax = 0)` in the batch, counted by the server, never sent as values).
- Triggers of both kinds fire (insert for the new rows, update for the others) and the warning says so, with the counts of 1.9.0.

### 4.2 Update only (`update_by_key`)

For corrections: the file's rows must exist. `UPDATE "t" SET "c" = CAST(x.c1 AS type) FROM unnest($1::text[], $2::text[], ...) AS x(c0, c1, ...) WHERE "k" = CAST(x.c0 AS type)`. The preview names the rows of the file that match no row and, as in a bulk change, **leaves them out and counts them** (`skipped`), or refuses when none matches. Each batch must update exactly the rows it carries, or the whole change rolls back. A key that is not unique cannot be used (the key is the table's own key or a unique constraint, as in 4.1).

### 4.3 Leave out the failing rows, and the rejects file

**The problem 1.9.0 hit:** the validation lists 20 failing rows and counts up to 100, because that is what the report can carry without becoming a table of the file. To leave rows out, the person must be told **all** of them.

**Design.**

1. A validation of an import may ask for **every failing row** (`listAll`), up to **1,000**. The adapter already finds failing rows by splitting the batch in halves, `O(failures x log n)` queries; the cost of 1,000 failures in 100,000 rows is measured in E0 and the limit set by the measurement. More than 1,000 failing rows: the dialog says so and the choice is not offered (the file needs fixing; it is not "a few bad rows").
2. The report still holds row numbers and rule names, **never a value**. The browser then offers **"Import the N valid rows"**: it removes the failing rows from the matrix it already holds and builds the usual `insert_rows` or `upsert_rows` of the rest. **Nothing in the server changes: it is the all-or-nothing import of the rows that remain**, so if another row fails in the real table (a race, or a rule the validation cannot see), everything rolls back as before.
3. The **rejects file** is made in the browser from the file's own rows plus a column `datacanvas_reject_v1` holding the rule name from the report ("unique key", "NOT NULL of qty", "does not fit integer"). It is a CSV with the original header and the file's own delimiter, **always written in UTF-8 with a byte order mark, whatever encoding the file was read in** (so no encoder for Windows-1252 or UTF-16 is needed, and a character that the old encoding could not hold is not lost), so it can be fixed and imported again. The server never sees it.
   - **Every field of the rejects file goes through the formula rule** of the SQL tab's export (a leading apostrophe on a value a spreadsheet would run), because a person will open it in one. **The rule is reversible, so fixing and importing the file again restores the value:** a value gets one more apostrophe when it begins with zero or more apostrophes followed by what the rule defuses (`=x` becomes `'=x`, `'=x` becomes `''=x`), and a file whose header ends in the reserved column **`datacanvas_reject_v1`** (a name no ordinary file is likely to have, with a version so the rule can change) is **offered** to the person by the import dialog as "This looks like a DataCanvas rejects file: ignore that column and restore the values?", **never treated as one silently**; if the person says yes, the dialog ignores that column and removes exactly one such apostrophe (the one that is followed, after any more apostrophes, by what the rule defuses). A property test: for any value, reading what was written gives the value back.
4. **Rules found only on the rows that got in.** The validation asks uniqueness and foreign-key questions only of the rows that were accepted by the copy (documented in 1.8.0): leaving out the rows that failed the first questions can reveal failures of the later ones. So after leaving rows out the dialog **validates the rest again** (automatically, up to 5 rounds, the reasons accumulating in the rejects), and the import is offered when a round finds nothing.
5. The choice is **explicit** (a button after a failed validation, never a default), and the dialog says how many rows will not be imported before it previews.

### 4.4 Other encodings

The dialog's error for a file that is not UTF-8 gains a menu: **Windows-1252 / Latin-1** (`windows-1252`, which is what a browser decoder means by `iso-8859-1`) and **UTF-16** (with its byte order mark). Decoding is the browser's `TextDecoder`. **`fatal: true` refuses a malformed UTF-8 or UTF-16 file, but a single-byte decoder (Windows-1252, Latin-1) accepts every byte**, so for those two there is no refusal to promise: the dialog **warns when the decoded text holds `U+FFFD` or a control character `U+0080` to `U+009F`** (the usual sign of a wrong choice), and the first rows of the preview show what was read so the person can see a wrong choice at once. The size limits count bytes of the file as before.

### 4.5 A progress bar (not built in 1.12.0)

**Not built in 1.12.0.** The owner dropped it, on this plan's own advice: it changes the shape of the route that carries every write, for a bar, and **Cancel and roll back** already works. An import keeps its spinner and the one JSON answer at the end. The design below is kept as it was written, in case a later release wants it.

The apply route answers a JSON object. For an import it becomes a stream of lines (`application/x-ndjson`): `{"batch":3,"of":200}` after each batch, then `{"done":{...}}` or `{"error":{...}}`. Everything the route refuses **before** the first byte (the preview is gone, the gate is closed, the connection is not unlocked) is still the usual JSON error with its status. After the first byte the status is 200 and the error is a line, with the fixed text by SQLSTATE and never the database's message (as the export's end-of-stream sentence). The cancel is the connection closing, as it is now. **This is the part most worth dropping if the milestone runs long**: it changes the shape of a route that carries every write, for a bar. See decision 4 of section 11.

## 5. Edit cells in the grid (`edit_cells`)

- A **double-click** on a cell of an editable table (or Enter on the focused cell, with the keyboard hook of 1.7.1) opens an in-place editor with the same value field as the form (NULL, empty, JSON, long text). Changes are **pending**: marked in the grid, listed in a bar ("5 cells in 3 rows changed"), and **never sent until the person opens the review**.
- **The review** lists every pending change row by row (the key, the column, before, after), paged, with a way to take one back, and then goes through the usual preview and apply. A local **undo** of pending edits is the browser's own (nothing was written).
- **The operation:** `{ kind: "edit_cells", table, rows: [{ key, changes: [{ column, value, expected }] }] }`, up to 500 rows and 50 cells a row. The planner makes, for each row, **one `UPDATE` with `buildUpdateRow`** (its own columns, its own `expected`) and checks that it changes exactly one row. No new statement. Conflicts are found at preview as for `update_rows`: a row that changed in a column being edited is left out and counted, `skipped`; none left is `row_changed`.
- **Key columns are not editable in the grid** (two rows swapping their keys, or a key moved onto another's, are cases for the form, one row at a time). Hidden columns, cut values, generated columns, `bytea` and a table without a key are not editable, for the same reasons the form gives, and the grid says why.
- **Paste from a spreadsheet** (a block of tab-separated cells starting at the focused cell, limited to the cells that can be edited) was a stretch goal of the milestone and **was not built in 1.12.0**: it reuses the pending-changes list and adds no server code, but it is a lot of interaction to test.
- The same validation as the form (a **Validate** button on the review) can be offered for the pending rows if E0 shows it is cheap: it is the whole-file validation with the pending values; it is not in the promise.

## 6. Bulk change of the rows a filter matches

This is the item the plans said to do "later, with the count typed to confirm", and the one with the most to get right, because it turns a filter into a change of up to 100,000 rows.

**The design that keeps the rule "a write is never built from conditions":**

1. The person has a filter on screen and presses **Set a value on all N matching rows** or **Delete all N matching rows** in the selection toolbar. (The toolbar offers it only when the filter has at least one condition: **an empty filter is refused**, never "the whole table"; that is `TRUNCATE`'s job, and DataCanvas does not do it.)
2. The request for the **preview** carries the same filter the page reader takes (the strict schema already checks it, and every value is bound) and the change (the column and value, or the delete). The server runs, in the preview's read-only transaction, **the page reader's own statement, asking for the key columns only, of the matching rows, up to 100,001** (to learn whether there are more than the limit). It **holds those keys in the plan** (server memory, five minutes, like any plan; not sent back) and returns only **the count**, the plan's words and the usual warnings. More than 100,000 matches: refused, saying the filter must be narrower.
3. The person **types the count** (a number, shown in the dialog) to enable Apply. A delete also needs the usual tick.
4. **Apply runs the keyed batches** (`update_by_key` for the update, a keyed `DELETE ... USING unnest(keys)` for the delete), 500 keys at a time, in one transaction, **each batch checked to touch exactly the rows it carries** (`expectRows`). A row that was deleted or changed in the key between the preview and the apply makes a batch short and rolls everything back (`row_changed`). **No `WHERE` built from a condition ever appears in a statement that writes.**
5. A bulk **update** with this operation does **not** compare the values the person saw (there is no page of values: the rows are the filter's). It says so in the preview: "the rows were chosen by the filter, and are changed even if they changed since". This is the same stance as a delete by key. A person who wants the check chooses the rows (1.9.0) instead.
6. **Limits:** 100,000 rows; **the keys held by the plan are also capped by size: 8 MB of key text in all** (the sum of the characters of every key value, counted as the preview reads them; a key value is at most 4,096 characters), so a table with long text keys cannot keep far more than the estimate, and a preview that would pass either limit is refused with "narrow the filter"; at most **one** such plan is held per connection (the oldest goes), so a plan cannot pile up as 20 imports could.
7. **Concurrency:** the set of rows can change between preview and apply (a row now matches, another no longer does). The change is applied to **the keys the person saw counted**, not to "whatever matches now": that is the point of resolving them at preview. **The identity is the key, and that is accepted on purpose:** if another session deletes a row and inserts a different one with the same key between the preview and the apply, the batch still touches one row for that key and the count still matches, so the new row is changed. A row-version token (`xmin`, `ctid`) was considered and refused: it changes on every update, so a harmless change by someone else in another column would roll the whole change back, and the key is the identity the person is shown. The preview says "rows are found by their key when you apply", as a delete by key always has.

## 7. Edit a cut text value

`getCell` (1.8.0) reads one `json` or `jsonb` value whole by the row's whole key. It is extended to `text`, `varchar` and `citext` columns (not `bytea`, not other types), keeping every rule of decision 156: the data-access check first, the same gate, the key bound, a hidden column refused, a value over 1,000,000 characters measured and not sent, and **editing limited to the 100,000 characters a change can carry** (a larger value can be read and copied, not changed). The grid's "cut" cell gets **Edit** only when the whole value is **at most 100,000 characters**, which the server says in its answer (the length is measured in the database before the value is sent); a value between 100,001 and 1,000,000 characters is shown for reading and copying with the reason, and a larger one says that it is too large to read here.

## 8. Security and privacy

| Risk                                                                                                | Control                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ON CONFLICT` targets a column the person should not match on                                       | The target is re-derived at preview from the catalog's unique and primary-key constraints; a request that names anything else is `invalid_change`; no partial or expression index                                               |
| An upsert overwrites more than the person saw                                                       | The preview counts the rows that exist and says "N will be overwritten"; the update needs the tick; the batch must report exactly the rows it carries; a different number rolls back                                            |
| A filter becomes a destructive `WHERE`                                                              | It never does: the filter is used by the **read** of the preview to find keys; the write is the keyed batch (section 6); an empty filter is refused; the count is typed; 100,000 at most; any short batch rolls everything back |
| The held list of keys is a memory risk                                                              | At most 100,000 keys, one such plan per connection, five minutes, dropped on lock, disconnect or data-access off, as every plan                                                                                                 |
| A rejects file holds the values of failing rows                                                     | It is made in the browser from the file the person already has, saved by the browser, kept nowhere by DataCanvas; the report from the server still holds no value (a test with a marker value in every cell)                    |
| Leaving out failing rows hides a failure the validation cannot see                                  | The import of what remains is the same all-or-nothing import: anything the validation missed rolls everything back                                                                                                              |
| A progress stream changes the error shape of a route that carries every write (not built in 1.12.0) | Errors before the first byte are unchanged; after it, one fixed-text line by SQLSTATE; tests for each; the route still takes only a preview id                                                                                  |
| `edit_cells` changes a key or a hidden column                                                       | Key, hidden, generated, cut and `bytea` columns are refused by the planner (the same `requireWritable` the form uses), not only by the grid                                                                                     |
| `getCell` of a text column as an oracle                                                             | As in decision 156: the whole key is required, a hidden column is refused, the data-access check comes first                                                                                                                    |
| A bigger plan and a stream make the preview store grow                                              | Import previews are capped (two per connection, from 1.9.0), the matching-rows plan to one, with the existing five minutes                                                                                                      |

Every new operation gets its rule tests (`tests/security.test.ts`): no text of SQL in the planner except through the builders, the strict schema with no field that holds SQL, `expect` or `expectRows` on every statement, the catalog check of the conflict target, and the call only through the write service.

## 9. Milestones

| #      | Work                                                                                                                                                                                                                                                                                                                           | Ends with                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **E0** | Measurements and spikes: `ON CONFLICT` with composite and partial keys and the `xmax` count on PostgreSQL 12 to 18; the cost of finding 1,000 failing rows in 100,000; the memory of 100,000 held keys; an NDJSON apply through the framework (does it stream, does a cancel arrive)                                           | Pinned spike tests and section 13 of this plan with the numbers, before any design is final     |
| **E1** | Encodings and **leave out the failing rows with a rejects file** (`listAll` in the validation, the browser logic, the re-validation rounds)                                                                                                                                                                                    | Adapter tests, parser tests, an end-to-end test with a file of mixed failures                   |
| **E2** | `upsert_rows` and `update_by_key`: schema, core, planner, preview counts, the tick, the dialog's mode and key choice                                                                                                                                                                                                           | Adapter tests including hostile names and the count checks; an end-to-end test                  |
| **E3** | Bulk change of the rows a filter matches: keys resolved at preview, the typed count, the keyed batches                                                                                                                                                                                                                         | The rules above as tests; an end-to-end test with a short batch (a row deleted between the two) |
| **E4** | `edit_cells` and the editing grid: pending changes, review, preview, the keyboard; **paste** if time allows                                                                                                                                                                                                                    | Planner tests (conflicts, key refusal), grid tests, axe, an end-to-end test                     |
| **E5** | Edit a cut text value (`getCell` for text). The progress stream was **dropped** (not built in 1.12.0)                                                                                                                                                                                                                          | Adapter and route tests                                                                         |
| **E6** | README, guide, `SECURITY.md`, the threat model (section 13 and the review table), decisions, changelog, version **1.12.0**; **the independent review of the whole write side of this release** (a fresh agent, throwaway tests, no source changed), every finding fixed with a test; the whole gate; the PostgreSQL matrix; PR | A PR the owner merges, and publishes themselves                                                 |

E1 to E4 are independent after E0 and can be done in any order; the order above puts the lowest risk first and the filter-wide change after the keyed batch it depends on.

## 10. Documentation to update (in the same change)

README (what you can do), `docs/getting-started.md` (the import modes, the rejects file, the encoding menu, "all matching rows", the editing grid), `SECURITY.md` (new write operations, the held keys, what the preview counts), `docs/threat-model.md` (a section for the new operations and the review table), `docs/decisions.md` (the decisions below), `docs/advanced-data-workspace-plan.md` (sections 19 and 20 point here), `CHANGELOG.md`, the version in the root and `packages/cli` `package.json` (the project uses pnpm now, so there is no `package-lock.json`).

## 11. Decisions taken (2026-11-23): every recommendation accepted

1. **Scope of 1.12.0.** _Recommend_ all of section 1. If it must be smaller: E1 and E2 (the import, finished), then E4; E3 last, because it is the largest risk.
2. **"All rows matching this filter"** (section 6) **by keys resolved at preview**, never a `WHERE` in a write, with the count typed to confirm, 100,000 at most, an empty filter refused. _Recommend_ exactly this. The alternative (a `WHERE` built from the conditions at apply) is simpler and is the thing the project has refused since 1.4.
3. **A bulk change by filter does not compare the values the person saw** (it is like a delete by key). _Recommend_ yes, said in the preview; the person who needs the check chooses the rows.
4. **The progress stream.** _Recommend_ **do it last and drop it if E5 runs long**: it changes the shape of the apply route for a bar, and "Cancel and roll back" already works. **Not built in 1.12.0** (the owner dropped it: it changes the shape of the route that carries every write, for a bar, and Cancel and roll back already works).
5. **Update-or-insert modes.** _Recommend_ the key chosen from the unique constraints (no partial or expression index in the first version), the updated columns a choice, "leave existing rows alone" included.
6. **The rejects file** is made in the browser, in the file's encoding and delimiter, with a `datacanvas_reject_v1` column. _Recommend_ yes; the 1,000-row limit is set by the E0 measurement.
7. **`edit_cells`: key columns not editable in the grid**, and paste from a spreadsheet as a stretch goal. _Recommend_ yes to both.
8. **`bytea`** stays read-only (a hex view is a separate, small read-only feature for a later release).
9. **An independent review at the end** of this release, as for 1.9.0. _Recommend_ yes, given the new statement shapes (`ON CONFLICT`, `UPDATE ... FROM unnest`, a keyed `DELETE`) and the held keys; it is the rule of this project that every change of the write path is read by a fresh pair of eyes.

## 12. Risks of the release itself

- **Two new statement shapes** after 1.9.0 added none. They are small and built from the same catalog names, bound arrays and count checks as the import batch, and they are the reason this release has a review of its own.
- **The filter-wide change** is where a mistake costs most. The design keeps the filter out of every write, makes the person type the count, and rolls back on any short batch; the review looks here first.
- **The leave-out loop** (validate, leave out, validate again) can run long on a big file with many layers of failure. Five rounds and 1,000 rows bound it; beyond that the person is told to fix the file.
- **The progress stream** (section 4.5) was the one change to a route that every write uses; it was cut, and is not built in 1.12.0.
- **Scope.** An editing grid invites a spreadsheet's whole behaviour (fill down, formulas, multi-cell selection). Only what is in section 5 is promised.

## 13. What E0 found

Measured on 2026-11-25 on **PostgreSQL 17.12** (the local Docker server of the tests, arm64), Node 22.14 and Next.js 16.4.6. The facts are pinned in three spike files in `packages/postgres-adapter/src/`: `postgres.adapter.keyed-writes-spike.test.ts` (sections 13.1 and 13.2; part of the usual suite whenever `DATACANVAS_TEST_PG_URL` is set, so `pnpm run test:pg-matrix` runs it), and the opt-in timings (`DC_SPIKE=1`, like the export spike of 1.8.0) in the same file, `postgres.adapter.listall-spike.test.ts` (13.3) and `postgres.adapter.held-keys-spike.test.ts` (13.4). **The run on PostgreSQL 12 to 16 and 18 is pending**: only `postgres:17` is available locally and no image was pulled (13.7 lists what may differ).

### 13.1 `ON CONFLICT` and the `xmax` count

The import batch with a conflict clause, `INSERT ... SELECT CAST(...) FROM unnest($1::text[], ...) AS x(...) ON CONFLICT (...)`, written by hand in the shape of `buildInsertBatch`:

1. **The arbiter** is inferred from a primary key or a full unique constraint, single or composite, in any column order. Part of a composite key infers nothing (`42P10`); a partial unique index is not inferred without its predicate (`42P10`; with its predicate it is); an expression index is not inferred from a column list (`42P10`).
2. **A `DEFERRABLE` unique constraint is refused as an arbiter: `55000`**, for `DO UPDATE` and `DO NOTHING` alike (and for `ON CONFLICT DO NOTHING` without a target, where every unique index is an arbiter). A deferrable constraint that is not the arbiter is checked as usual. **The plan did not say this:** the keys offered in 4.1 must also leave out deferrable constraints (`pg_constraint.condeferrable`), or the apply fails with an error the person cannot act on.
3. **`NULL` never conflicts** in a nullable unique column (a second row with `NULL` is inserted); with `NULLS NOT DISTINCT` (15 and later) it conflicts and updates. This confirms the rule of 4.1 that every key column is `NOT NULL`.
4. **A conflict on a unique constraint that is not the arbiter is an error (`23505`), not an update**: keyed by a unique `code`, a new code whose `id` belongs to another row rolls the whole import back. Two consequences for E2: the default "update every mapped column that is not the key" can include the columns of another unique constraint, even the primary key (`DO UPDATE SET "id" = EXCLUDED."id"` moves a row's key, and can meet `23505` or a foreign key), so those columns should be left out of the default or refused; and the validation of an upsert must not count a row of the file that matches an existing row **by the chosen key** as `unique_existing` (that row is an update), nor, for the other unique keys, a collision with the very row it updates.
5. **The counts.** With `DO UPDATE`, `rowCount` is every row of the batch (inserted and updated); with `DO NOTHING`, only the rows that were new. `RETURNING (xmax = 0) AS inserted` says, row by row, which were inserted, and `rowCount` stays the number of rows, so the existing `expectRows` check is unchanged (500 booleans come back per batch, no value). Counted in the database instead (`WITH w AS (... RETURNING ...) SELECT count(*) FILTER ...`), `rowCount` is 1, so the check would have to read the counts. A `DO UPDATE ... WHERE` (say "only when something changed") leaves rows out of `rowCount`: do not add one.
6. `xmax` reads "updated" for a row that an earlier batch of the same transaction inserted, and for a row that another session holds `FOR KEY SHARE` (an open transaction that added a child row): updating columns that are not the key does not wait for that lock.
7. **`xmax` is not always available (this contradicts 4.1's "`RETURNING (xmax = 0)` in the batch"):** on a **partitioned table** it fails with `0A000` ("cannot retrieve a system column in this context"), and it needs **`SELECT` on the table** (a system column: grants on every user column are not enough, `42501`). The upsert itself works on a partitioned table. Recommendation: use `xmax` when the target is an ordinary table and the role may read it (both known at preview); otherwise the result says "N rows inserted or updated" and the preview's split (its read-only count of the existing keys) is shown as the estimate it is.
8. **Two rows of one batch with the same key:** `DO UPDATE` fails with `21000` ("cannot affect row a second time"; the message and hint hold no value); `DO NOTHING` keeps the first and the batch is one row short, which the count check rolls back as `unexpected`. **Across two batches of one transaction it is not an error** (the second batch updates the row the first inserted), so the refusal of duplicate keys in 4.1 must be over the whole file, as the validation's `unique_in_request` already is, not per batch.
9. **Triggers (a correction to 4.1):** `BEFORE INSERT` row triggers fire for **every** row of the batch, including the ones that turn into updates; then `BEFORE UPDATE` and `AFTER UPDATE` fire for those, and `AFTER INSERT` only for the new ones. The warning must say that the insert triggers run for every row.
10. **Privileges:** a conflict target needs `SELECT` on the key's columns (even with `DO NOTHING`); `DO UPDATE SET "c" = EXCLUDED."c"` needs `SELECT` and `UPDATE` on `c`; `xmax` needs `SELECT` on the table. A refusal is `42501`, which is already `write_denied`.
11. **Time:** 100,000 rows in 200 batches of 500, in one transaction, on a table of 200,000 rows: the upsert with `RETURNING (xmax = 0)` took **0.92 s**, half inserted and half updated, every batch counted.

### 13.2 `UPDATE ... FROM unnest` and `DELETE ... USING unnest`

1. `rowCount` is the number of **rows of the table touched**: every key present gives the number of keys carried; a key that matches no row (or a `NULL` key) makes it short.
2. **A key carried twice counts once** (the row is updated once, with one of the two values, which one is not defined). So a batch of `update_by_key` with a repeated key is short and would roll back as `row_changed`, which is misleading. **The plan did not say this:** 4.2 must refuse a file with a repeated key (the validation's `unique_in_request` on the chosen key) before planning, so that "short" always means "a row is gone". The keys of section 6 come from a read of a unique key, so they cannot repeat.
3. A key that does not cast fails the whole statement (`22P02`), as the import batch does; deleting a row that is still referenced is `23503`, as for one row; a composite key works the same.
4. **One batch is planned as `Nested Loop > Function Scan (unnest) > Index Scan` on the key's index**, never a scan of the table (500 keys against 200,000 rows).
5. **Time** for 100,000 rows in 200 batches of 500 in one transaction on 200,000 rows: `UPDATE` by an integer key **0.81 s**, by a text key **0.96 s**; `DELETE` by key **0.23 s**; each batch touched exactly the rows it carried. The bulk change of section 6 is seconds, not minutes.

### 13.3 The cost of finding every failing row (`listAll`)

The real `validateRows` (halving with savepoints), with only its stop (`VALIDATE_MAX_FAILURES_FOUND`, 100) raised so that it searches to the last failing row; a file of 100,000 rows of five columns into a table that already holds 100,000 rows. "Check" is a value a `CHECK` refuses (classified by its SQLSTATE alone); "type" is a value that does not cast, in the last column (classified by casting the row's cells one at a time, the costliest case). "Evenly" is the worst case for halving.

| Failing rows | Where   | Kind  | Statements | Time    |
| ------------ | ------- | ----- | ---------- | ------- |
| 0            |         |       | 19         | 0.32 s  |
| 100          | evenly  | check | 7,700      | 4.27 s  |
| 500          | evenly  | check | 31,060     | 13.12 s |
| 1,000        | evenly  | check | 55,108     | 22.70 s |
| 2,000        | evenly  | check | 96,204     | 36.65 s |
| 100          | evenly  | type  | 9,700      | 4.94 s  |
| 500          | evenly  | type  | 41,060     | 16.45 s |
| 1,000        | evenly  | type  | 75,108     | 29.36 s |
| 2,000        | evenly  | type  | 136,204    | 51.49 s |
| 1,000        | random  | check | 51,377     | 20.44 s |
| 1,000        | a block | check | 8,131      | 3.33 s  |

- The cost is **round trips** (about 0.4 ms each here): about 55 statements per failing row for the halving (`SAVEPOINT`, `INSERT`, `RELEASE` or `ROLLBACK TO` and `RELEASE` per slice), and 20 more for a value that does not cast. Re-inserting rows is the smaller part (no failure: 0.32 s for the whole file).
- **This contradicts the assumption of 4.3 that 1,000 is affordable as things are:** the validation's deadline is the **whole** validation (`statementTimeoutMs`, 15 s by default, in `validateRows`), and 1,000 spread-out failing rows take 20 to 29 s; even 500 take 13 to 16 s. The limit of 100 of today already costs up to 5 s.
- **Recommendation:** keep the **limit at 1,000** and give a `listAll` validation **its own deadline of 60 s** (twice the worst case measured), with the dialog's cancel. If the deadline must stay at 15 s, the limit is **250** (about 8 to 9 s at worst, by the slopes of the table). Fewer statements per slice (for example a savepoint kept and rolled back to, instead of released and made again) would lower the cost; that was not measured. The uniqueness and foreign-key queries list 20 row numbers (`[1:20]` and `VALIDATE_ROWS_LISTED`); `listAll` needs them raised to the limit, which costs one query each as now.
- Writes need a local database, so local round trips are the case to plan for; over a slower link the time grows with the round trip.

### 13.4 The memory of the held keys

Heap measured after a full collection, the keys built as the driver makes strings:

| Keys                                              | Held as                                        | Heap                     |
| ------------------------------------------------- | ---------------------------------------------- | ------------------------ |
| 100,000 integer keys                              | one `{ column, value }` per key column per row | 12.8 MB (128 bytes each) |
| 100,000 integer keys                              | one array of text per batch of 500             | 3.3 MB (33 bytes each)   |
| 100,000 (integer, 12-character text) keys         | arrays per batch                               | 7.5 MB                   |
| 100,000 `uuid` keys (36 characters)               | arrays per batch                               | 6.5 MB                   |
| 2,048 keys of 4,096 Latin-1 characters (the cap)  | arrays per batch                               | 8.4 MB                   |
| 2,048 keys of 4,096 other characters (the cap)    | arrays per batch                               | 16.8 MB                  |
| 100,000 keys of 4,096 Latin-1 characters (no cap) | arrays per batch                               | 412 MB                   |

- The preview's read of 100,001 integer keys of a filter (key column only, ordered by the key, in a read-only transaction) took **39 ms**, and the driver's rows **6.6 MB**; an `int4` arrives as a number, so the plan turns it into text. 2,049 keys of 4,096 characters took about 1 s (compressed values).
- **The 8 MB cap is sensible**: it binds only when the keys average more than about 84 characters (8,388,608 / 100,000), and it is below what one import preview already holds (a body of up to 32 MB, two per connection). Without it, 100,000 long keys would be about 400 MB. **A precision for 6.6:** "8 MB of key text" counts characters, and a string with any character outside Latin-1 takes two bytes a character, so the cap is **up to about 17 MB** of memory; the plan should say "8 million characters". At one such plan per connection and 10 connections, the worst case is about 170 MB.
- **Hold the keys as the batches will bind them** (one array per key column per batch), not as `{ column, value }` objects: four times smaller.
- A B-tree entry is limited to about 2,700 bytes, so a key value of 4,096 characters exists only when it compresses: the limit of a value is a cap, not a likely size.

### 13.5 Streaming the apply answer, and the cancel

- **From the code.** The apply route already hands `request.signal` to `writes.apply`, and `runPlan` checks it between statements. In Next.js 16.4.6, `request.signal` aborts when the response closes before it has finished (`signalFromNodeResponse`), which is before or after the first byte; a streamed body is written chunk by chunk with `res.flush()` when compression is on (`pipeToNodeResponse`); and the built-in compression does not compress `application/x-ndjson` (it is neither in its list nor `text/*` or `+json`). The export route already streams a `TransformStream` through the same path.
- **A probe** (a throwaway Next.js app outside the repository, with a pass-through `proxy.js` like the app's `proxy.ts`, one route writing an NDJSON line every 200 ms; `next dev` and `next build` with `next start`, compression on): **the lines arrived 200 ms apart** in both, `application/x-ndjson` had no `Content-Encoding` (a `text/plain` answer was gzipped but still flushed line by line). **A client abort after three lines reached the handler**: `request.signal` aborted about 9 ms later, the stream's `cancel()` was called, and the work stopped before the next batch. So the framework streams and passes a cancel; nothing in 4.5 is contradicted.
- Not checked: the real app (its `proxy.ts` and its standalone `server.js`, which runs the same router as `next start`), a reverse proxy in front, and browsers other than Node's `fetch`. The SQL run's end-to-end test already shows an abort reaching `request.signal` in the real app for a JSON answer.
- For E5: every error before the first byte must be settled before the route returns its `Response` (as `exportRows` does with its first promise), and a write to a stream the client cancelled rejects, which must be treated as a cancel and roll back.

### 13.6 What changes in the plan

1. 4.1: leave out **deferrable** unique constraints from the keys offered (`55000`).
2. 4.1: `RETURNING (xmax = 0)` **fails on a partitioned table** (`0A000`) and **needs `SELECT` on the table**; use it only where it works, and say "inserted or updated" otherwise.
3. 4.1: `BEFORE INSERT` triggers run for **every** row of an upsert, not only the new ones.
4. 4.1: the default updated columns must not include another unique key or the primary key (`23505`, or a key moved under a foreign key).
5. 4.1 and E1: an upsert's validation must not count a match on the chosen key as `unique_existing`, nor a collision of another key with the row being updated.
6. 4.2: refuse a file with a **repeated key** before planning `update_by_key` (a repeated key makes a short batch that would read as `row_changed`).
7. 4.3: **1,000 failing rows do not fit the 15 s deadline** (20 to 29 s): a 60 s deadline for `listAll`, or a limit of 250.
8. 6.6: the cap is 8 million **characters** (up to about 17 MB), held as arrays per batch.

### 13.7 Pending: PostgreSQL 12 to 16 and 18

Run `pnpm run test:pg-matrix` (it runs the keyed-writes spike with the rest of the adapter's tests), and the opt-in timings with `DC_SPIKE=1` against at least the oldest and newest versions. What may differ between versions:

- `NULLS NOT DISTINCT` exists from 15 (its test skips itself below 15).
- `RETURNING xmax` on a partitioned table (`0A000` expected from 12 on; to confirm on each).
- The `xmax` readings of 13.1 (6): they follow from how a row lock is carried to the new row version, which PostgreSQL does not document.
- The plan of a batch: the row estimate of `unnest` of a bound array comes from a planner support function (from 12).
- PostgreSQL 18's `RETURNING old` and `new` might replace `xmax` there; not measured, and it is 18 only.
- `55000` for a deferrable arbiter, `42P10`, `21000`, the trigger order and the privilege checks are long-standing (9.5 on) and expected the same.
- The times and sizes are of one machine and one version; they are logged by the opt-in spikes, not asserted beyond loose bounds.

### 13.8 What E3 measured (the server side of section 6)

Measured on 2026-11-26 on the same PostgreSQL 17.12, by `postgres.adapter.writes-matching.test.ts` (it prints the times; only the counts are asserted), on a table of 100,001 rows with an integer key. The preview reads the keys through the page reader's statement as a cursor, 500 keys a fetch, so a refusal stops the read early.

| What                                                                                           | Time            |
| ---------------------------------------------------------------------------------------------- | --------------- |
| Preview of `update_matching` that finds 100,000 keys (catalog checks and value check included) | 0.20 s          |
| Refusal of a filter that matches 100,001 rows                                                  | 0.20 s          |
| Apply: 100,000 rows updated in 200 keyed batches, one transaction                              | 0.46 s          |
| Preview of `delete_matching` of 100,000 keys / its apply                                       | 0.25 s / 0.33 s |
| Preview of 1,953 keys of 4,096 characters (7,999,488 characters, just under the cap)           | 0.04 s          |
| Refusal of 1,954 such keys (over 8,000,000 characters)                                         | 0.04 s          |

Found while building it:

1. The write path's source rule (`writes/rules.test.ts`) refused the word `USING` anywhere, to keep `ALTER COLUMN ... TYPE ... USING <expression>` out (decision 132). The keyed `DELETE ... USING unnest(...)` of 13.2 needed the rule narrowed to exactly that one line of `keyed.ts`.
2. The tick of a destructive change is enforced by the browser's dialog only (the server marks the preview `destructive`). So the typed count is checked by the **write service** instead: the apply request carries `confirmRows`, which must equal the count the preview found, compared before the preview is taken (a typing mistake does not use it up). `update_matching` and `delete_matching` are both destructive (always the tick), like `update_by_key`.
3. A key value over 4,096 characters is refused as well (6.6), and the conditions are checked against the first 100 columns, as the page reader checks them.

### 13.9 What E4 measured (the server side of section 5)

Measured on 2026-11-26 on the same PostgreSQL 17.12, by the opt-in timing of `postgres.adapter.writes-cells.test.ts` (`DC_SPIKE=1`; it prints the times, only the counts are asserted), on a table of 500 rows and 51 text columns.

| What                                                                 | Preview | Apply  |
| -------------------------------------------------------------------- | ------- | ------ |
| `edit_cells` of 500 rows of 50 cells, every value different (25,000) | 24.89 s | 0.31 s |
| `edit_cells` of 500 rows of one cell                                 | 0.22 s  | 0.21 s |

Found while building it:

1. The preview checks each **distinct** value by its type with the form's own `checkValues` (a savepoint, a cast and a release: three round trips a value), so a change of 25,000 cells (500 rows of 50) took 25 s to preview. **As built, a change is capped at 2,500 cells in all** (`EDIT_CELLS_MAX_CELLS`, besides 500 rows and 50 cells a row), which is the answer to this measurement; the preview of a change of that size was not measured again. An edit of a few hundred cells stays well under a second; a pasted block (the stretch goal of section 5) could reach the limit. If paste is built, either the check casts a column's values in one read of the preview's transaction, or the change caps its cells in all (for example 5,000). Paste was not built, so neither is done: the plan asks for no new statement.
2. The planner cannot tell a value the grid cut short (its first 2,000 characters) from a value that changed: both are a seen value the row does not hold, so the row is **left out** (`skipped`) and never overwritten. Saying why, before the review, is the grid's job, as `cellEditBlock` does for the form.
3. A key column whose name looks sensitive must be in `revealColumns` (as `getCell` asks), or the rows left out would tell whether a guessed key exists.

### 13.10 What E5a found (edit a cut text value)

Found by `postgres.adapter.cell.test.ts` and the route tests (no timing was taken):

1. `getCell` reads a column whole only when its own type is `text`, `varchar` (with or without a length) or `citext` (the extension's own type, not a domain or a type of the same name made by a user). `char(n)` (blank padded), `name`, a domain over `text`, `bytea`, numbers and arrays are refused as `invalid_request`, and so is a hidden column that was not revealed.
2. The answer carries the length measured in the database (`length`, in characters; null for SQL NULL) and `editable`. A value of 100,000 characters is editable, 100,001 is read and copied only, 1,000,000 is read, and 1,000,001 is measured and **not sent** (`tooLarge`).
3. A character outside the basic plane is two units in a change, so a value of 60,000 such characters (120,000 units) is read but **not** editable: the length of the string that would be carried decides as well as the database's count.
4. Whole-key and revealing rules of decision 156 hold unchanged for text: the data-access check comes first, the key is bound, every key column of a sensitive name must be revealed (the browser's `cellRequestFor` names them), and no error or log holds a value.
5. In the browser, the whole value that was read becomes the `before` of the pending change (what `expected` is checked against), never the 2,000 characters the grid showed. A cell that is part of the key, hidden, generated, `bytea` or of another type is not offered this edit.

### 13.11 What the independent review of 1.12.0 found (fixed)

1. **An import by key was an existence oracle on a hidden key.** `update_by_key` and `upsert_rows` previews said which rows of the file found a row, so a guessed value of a key whose name looks sensitive (`api_key`) could be tested. Both now refuse such a key at preview (`resolveKeyedImport`), with a fixed sentence naming the column and never a value; the import dialog does not offer a key with such a column and says how many it left out. Updating a sensitive column's value is as allowed as before; only the key that finds rows is refused. A unique violation on apply of a sensitive column that is written still names no value but says a unique key was hit; that is unchanged.
2. **The cut-text editor rewrote line endings.** A text field returns CRLF and bare CR as LF, so the first keystroke changed every line ending of the value while `expected` kept the original. A value with a carriage return is now read-only in that editor, with a fixed reason, and a pending cell set to its own value with the line endings normalized is not a change.
3. **A repeated key was missed under a nondeterministic collation.** The file's keys were grouped under the default collation, but the unique index compares under the column's own (`k0` and `K0` are one key under a case-insensitive ICU collation), so a repeated key in a second batch passed the preview and wrote one row less than counted. The catalog's collation of the key column (when it is not its type's default, quoted) is now applied in the grouping.
4. **A filtered delete on a table that cascades onto itself failed at apply with "a row is gone".** One batch deletes all its keys in one statement, so the cascade finds nothing left and it runs (with a warning); more than one batch is refused at preview, because an earlier batch's cascade removes rows of a later one.
5. **A table that has child tables (table inheritance) was accepted for keyed changes**, which also reach the children and fail with a generic error. `upsert_rows`, `update_by_key`, `update_matching`, `delete_matching` and `edit_cells` now refuse it with a fixed sentence; partitioned tables are not refused. The older `update_row`, `delete_row`, `update_rows` and `delete_rows` use no `ONLY` either and were not changed (they stay fail-closed on their own row counts).
6. The browser now refuses, before preview, a set of pending cells whose text (each new value plus each value seen, in UTF-16 characters) would pass the 32 MB body limit.
