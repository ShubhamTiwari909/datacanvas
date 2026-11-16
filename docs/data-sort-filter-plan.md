# Plan: sorting and filtering rows in the data viewer

Status: **design settled 2026-11-16 (all seven recommendations accepted, section 8); nothing built.** This is the part of milestone M4 that `docs/data-viewer-plan.md` (decision 6, section 5.3) left for its own design, because it lets the browser's choice of column and value shape the `SELECT`. The decisions are in section 8. Numbers in section 2 were measured on 2026-11-16 on one machine; they show shape, not guarantees.

## 1. Goal and non-goals

Let a person, inside the Data section and without writing SQL:

- **sort** the rows by one column, ascending or descending;
- **filter** the rows by up to three conditions on columns (for example `status` equals `shipped`, `name` contains `smith`, `deleted_at` is null).

Both keep every rule of the viewer: read-only, one page at a time, bounded, nothing saved or logged, and **no text typed by the user ever becomes part of the SQL** (section 4.5).

Not in scope: sorting by several columns; OR, NOT or grouped conditions; regular expressions, full-text search, JSON paths; a count of the matching rows (it would be a scan); saving or sharing a filter; exporting; filtering across tables; foreign tables (decision 4 of the viewer plan stands).

## 2. What measuring showed

A table of 5 million rows (965 MB) on PostgreSQL 17, 15 s limit, results in milliseconds:

| Read                                                             |  Time |
| ---------------------------------------------------------------- | ----: |
| Page 1 by primary key, or any later page (as built today)        |     1 |
| Sort by an indexed column                                        |     1 |
| Equals on an indexed column                                      |     1 |
| Sort by an unindexed column (ascending, descending, int or text) |  ~230 |
| Equals on two unindexed columns, nothing matches                 |  ~100 |
| "Contains" on a 100-character column, nothing matches            | ~3900 |

Three things follow.

1. **Most sorts and filters are cheap even without an index**, because PostgreSQL keeps only the best 51 rows while it scans, and scans in parallel. "Contains" is the exception: it does work on every character of every row, so it is the operator that grows fastest.
2. **The planner's cost estimate cannot be trusted to refuse a read.** `EXPLAIN` accepts the bound parameters through the driver, but for a filter that matches nothing it estimates a cost of 9 (it assumes the `LIMIT` is reached early) for a read that scans the whole table. A pre-check built on it would let through the reads that hurt.
3. **So the guard is time, not a model**: these reads run with a shorter statement timeout than a plain page, and when one is stopped the person is told why and what to try (section 4.6). It measures reality, needs no catalog rules, and the existing limit of one running read per connection already bounds the load.

## 3. What the person sees

- **Sort:** a column header becomes a button. Click to sort ascending, again for descending, again to go back to the key order. The header says which with `aria-sort` and an arrow. A column that cannot be sorted has a plain header and a tooltip that says why.
- **Filter:** a "Filter" control above the grid opens a small panel: pick a column, pick an operator (the choices depend on the column's type), type a value, add. Active filters show as removable chips, with "Clear all". Up to three, combined with AND.
- **Notes under the grid** say what was applied, in words: "Ordered by city (ascending), then by id (the primary key)." and "Filtered: status equals shipped." The estimated row count is dropped while a filter is on, because it would describe the table and not the matches (a count would be a scan).
- **Empty result:** "No rows match these filters." with the chips still visible. **Too slow:** the message in section 4.6. **Invalid value** (for example text typed for a number column): "That value is not valid for this column's type (integer)." The database's own message is never shown, because it contains the value.
- Any change to the sort or the filters starts again from the first page and empties the trail of cursors.
- Sort and filters live in component state with the rows: gone when the view goes, never persisted, never in a workspace or snapshot (the same rules as rows, enforced by the same tests).

## 4. How it works

### 4.1 Request and response

`rowsRequestSchema` stays strict and gains two optional keys:

- `sort`: `{ column, direction: "asc" | "desc" }`
- `filters`: up to 3 of `{ column, op, value? }`, where `op` is one of a fixed list (4.4) and `value` is text of at most 200 characters, absent for `is_null` and `is_not_null`.

`where`, `orderBy`, `order`, `filter`, `sql`, `query`, `limit`, `offset` and `columns` stay refused as keys, and the existing test that says so stays unchanged: the two new keys are `sort` and `filters`, which that list never contained. Each column in the response gains `kind`: `"text"`, `"ordered"` or `"other"` (4.2), so the browser knows which operators to offer without guessing from type names. The page echoes the applied `sort` and `filters`, so the notes under the grid describe what the server did.

### 4.2 What can be sorted and filtered

The `kind` of a column comes from the catalog, once, with the column list: **text** is the string category (`text`, `varchar`, `char`, `name`); **ordered** is any other type with a default btree operator class (numbers, dates and times, booleans, uuid, enums, ranges; domains count as their base type); **other** is everything else (`json`, `xml`, arrays, composites, `bytea`, geometric types).

| Kind    | Operators                                                                                | Sortable |
| ------- | ---------------------------------------------------------------------------------------- | -------- |
| text    | everything under "ordered", plus contains and starts with                                | yes      |
| ordered | equals, not equals, greater, greater or equal, less, less or equal, is null, is not null | yes      |
| other   | is null, is not null                                                                     | no       |

Four rules that are not about types:

- **A hidden column can be neither sorted nor filtered.** A filter on a column the viewer masked is an oracle: "starts with a", "starts with b" reads the secret one letter at a time without ever showing it. The server refuses it (`invalid_request`) unless the person revealed that column for this view. If a column is hidden again, the browser drops any sort or filter that uses it.
- **Only a table with a key can be sorted.** The key columns are the tie-breaker that makes the order total and stable; without them a page boundary can skip or repeat rows. A table without a key (and a materialized view, which is always read unordered) can be filtered, paged by position as today, but not sorted, and the header says why.
- **Only the columns the viewer shows** (the first 100) can be used.
- **Every column name is matched against the catalog** by exact string comparison and quoted; the client's text is never used as an identifier.

### 4.3 Paging with a sort

The viewer's keyset paging extends to a sort column. The order is the database's own default: `ASC NULLS LAST`, or `DESC NULLS FIRST`, so a plain index on the column can serve it, followed by the key columns ascending. The cursor carries the last row's sort value (or NULL) next to its key values, both untruncated and bound as parameters.

```
ORDER BY "c" ASC NULLS LAST, "k1", "k2"
-- after a row whose c is not NULL:
WHERE ("c" > $s OR ("c" = $s AND ROW("k1","k2") > ROW($k1,$k2)) OR "c" IS NULL)
-- after a row whose c is NULL:
WHERE ("c" IS NULL AND ROW("k1","k2") > ROW($k1,$k2))
```

Descending mirrors it with `<` and the NULLs first. The sort value is read cut to 1,025 characters; if the last row's value is longer than 1,024, no cursor can be made and the page ends with a note ("Paging stops here: the value is too long to continue from"). The cursor's arity is checked against the request (`k` plus `s` when sorted), so a cursor from another sort or table is refused as invalid; a forged cursor can still only change where the page starts.

### 4.4 Filters in the statement

The conditions join the existing `WHERE` with AND. Values are bound parameters; PostgreSQL types a parameter from the column it is compared with, so typed comparison works without writing a cast, and a value that does not fit the type raises a data exception that the adapter already turns into a fixed `invalid_request`.

| Operator                            | Written as                                                           |
| ----------------------------------- | -------------------------------------------------------------------- |
| equals, not equals                  | `"c" = $n`, `"c" IS DISTINCT FROM $n` (so a NULL is not "not equal") |
| greater, less (and with "or equal") | `"c" > $n` and so on                                                 |
| is null, is not null                | `"c" IS NULL`, `"c" IS NOT NULL`                                     |
| contains (any case)                 | `strpos(lower(CAST("c" AS text)), lower($n)) > 0`                    |
| starts with (any case)              | `starts_with(lower(CAST("c" AS text)), lower($n))`                   |

`contains` and `starts with` avoid `LIKE` on purpose: the person's `%`, `_` and `\` are then ordinary characters and nothing needs escaping. Equality is exact and typed. `starts_with` needs PostgreSQL 11 or newer; the supported floor is 12.

### 4.5 "No text typed by the user becomes SQL", still true

Today the statement has one shape. With this change it has a small family of shapes, and the rule that keeps it safe is unchanged in spirit: **every fragment of SQL text comes from a fixed list or from the catalog, and every user-chosen value is a bound parameter.** Fragments: operator text from the table above, selected by an enum value; identifiers from the catalog, quoted; `ASC` or `DESC`, selected by an enum; parameter numbers. The query builder stays one pure function with no access to the request's strings other than through those lookups. A test (section 5) builds statements from many generated requests, including hostile column names and values, and asserts that every statement matches a written grammar and that no value or name from the request appears in the statement text except as a quoted catalog identifier.

### 4.6 Cost: a shorter timeout

A read with a sort or a filter runs with a statement timeout of **5 seconds** (a plain page keeps the existing 15). The transaction wrapper gains an optional timeout for the call. When a read is stopped, the person sees a fixed message and a new error code, `rows_too_slow`:

> This took longer than 5 seconds, so it was stopped. On a large table, sort or filter by a column that has an index, or narrow the filter.

Five seconds is chosen from section 2: unindexed sorts and equality stay far below it up to millions of rows, and `contains` crosses it at a few million rows of wide text, which is the case worth stopping. The existing rule of one running read per connection (three waiting, then `429 rows_busy`) bounds the load of repeated tries. The message names no table, column or value.

### 4.7 Where the work goes

| Layer                       | Change                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database-core`    | `RowsOptions` gains `sort` and `filters`; `RowColumn` gains `kind`; the page echoes what was applied; the cursor gains the sort value; validation of both against the column list. |
| `packages/postgres-adapter` | Column `kind` from the catalog; the query builder with the fixed grammar; the shorter timeout; the sort-value limit and its note.                                                  |
| Mock and contract tests     | The mock sorts and filters the sample data the same way; a shared contract block, so mock and PostgreSQL agree (NULL placement, ties, case).                                       |
| `packages/shared-types`     | The two request keys, `kind` and the echo in the response, the `rows_too_slow` code.                                                                                               |
| `apps/web` server           | Pass-through and the new error code; no logging of either key.                                                                                                                     |
| `apps/web` UI               | Sort headers, the filter panel and chips, notes, the reducer actions that reset the trail, the empty and too-slow states, in both themes.                                          |

## 5. Tests

- **Pure:** the query builder's grammar and parameters for every operator and direction; the cursor with a sort value, NULL and arity; the reducer; the notes.
- **Generated:** the grammar test of 4.5 over many random requests, including identifiers with quotes, emoji, SQL words and 63 bytes, and values that look like SQL.
- **Adapter, real PostgreSQL, 13 to 18:** sorting with ties, NULLs and descending across page boundaries (walking every page must visit every row exactly once); the sort value longer than the limit; each operator on each kind; a hidden column refused until revealed; a table without a key refused for sort and allowed for filter; a value of the wrong type giving the fixed message and no value; the shorter timeout stopping a deliberately slow read (`pg_sleep` in a view) with `rows_too_slow`.
- **Server and security:** the strict schema's refusals; the same refusal whether or not the table exists when data access is off; no sort or filter value reaches a log or an error; sort and filter state appears in no store, file or workspace (the existing rules, extended).
- **Browser:** sort by clicking, filter and clear, paging with a sort, the keyboard, blur still applying, a too-slow message, light and dark, and an accessibility audit of the new controls.

## 6. Security and privacy analysis

| Risk                                                   | Mitigation                                                                                                | Left over                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A filter reads a hidden column letter by letter        | Hidden columns refused for sort and filter until revealed (4.2)                                           | Names are only a hint, as before                                                             |
| SQL injection through a column name, operator or value | Names from the catalog, operators from a fixed list by enum, values bound; generated grammar test (4.5)   | None known                                                                                   |
| An expensive filter loads the database                 | 5 s timeout, one running read per connection, `rows_busy` (4.6)                                           | Each try costs up to 5 s of work (the transaction's setting replaces any limit the role has) |
| A filter value (typed by the person) leaks             | Held in component state only; never logged, stored, cached or put in a URL (POST); errors never repeat it | The browser's own memory                                                                     |
| Wrong results: a skipped or repeated row when paging   | Key as tie-breaker, sort value in the cursor, a test that walks every page; no sort without a key         | A table changing while it is being read, as today                                            |
| Row-level security hides rows from a filtered view     | The existing notice still shows                                                                           | None new                                                                                     |

## 7. Milestones

Each is a separate PR ending with `npm run check`, the browser tests and the PostgreSQL 13 to 18 matrix.

| #   | Milestone                                                                                                                                           | Size |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| S1  | **Adapter and core**: column `kind`, sort with keyset paging and NULLs, filters, the shorter timeout, the generated grammar test, mock and contract | L    |
| S2  | **Server**: the schema keys, `rows_too_slow`, route tests, security rules                                                                           | S    |
| S3  | **Screens**: sort headers, the filter panel, notes, states, accessibility, browser tests                                                            | L    |
| S4  | **Documents**: this plan's findings, the threat model and getting-started text, the changelog for the release it ships in                           | S    |

Sort alone is a smaller first step (S1 and S3 without the filter panel) and can ship earlier if the owner prefers; the design above covers both so the cursor and the request do not change twice.

## 8. Decisions (settled 2026-11-16)

All seven recommendations were accepted as written.

1. **Scope: sort and filter together, or sort first?** Decided: design both (done here), build **sort first** (it is the smaller, safer half and covers "show me the newest"), then filters. Both belong to 1.3.0 (decision 7); sort is built first so that it can be released alone if the filters take much longer.
2. **How to guard cost.** Decided: the shorter timeout of 4.6 (5 seconds). Alternative: a planner pre-check from `EXPLAIN`, which section 2 shows would miss the reads that hurt. Alternative: no extra guard, only the existing 15 seconds.
3. **An override button** ("try anyway, up to 15 seconds") after a too-slow stop? Decided: **no** in the first version; the 15-second limit already exists for every other read, and an override invites repeated heavy reads against a database the person may not own.
4. **Tables without a key:** filter yes, sort no. Decided as written (4.2).
5. **Hidden columns:** not sortable or filterable until revealed. Decided as written; this is a security rule rather than a preference, and it is tested as one.
6. **Case:** `contains` and `starts with` ignore case; equality is exact. NULL placement follows the database (`ASC` last, `DESC` first), so plain indexes can serve sorts. Decided as written.
7. **Which release.** The viewer is complete without this. Decided: finish M5 and **publish 1.2.0 first**, then ship sort and filter as 1.3.0, and editing after that. This keeps each release small and lets the viewer's wording settle before it grows.

## 9. Later

Several sort columns; OR groups; filters on JSON fields and array elements; a regular-expression operator (high cost, needs its own limits); a per-table "this column is indexed" hint in the header from the index list the Structure tab already reads; a nullable unique key for materialized views (candidate noted in viewer plan section 15, item 1).

## 10. Consequence for the release order

Decision 7 puts the viewer's release first: **M5 (documents, changelog, version 1.2.0) is next**, and sort and filter follow as 1.3.0, built as S1 to S4 (section 7) after 1.2.0 is published. The editing plan's suggested version moves from 1.3.0 to 1.4.0 accordingly.
