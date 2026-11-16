# Plan: sorting and filtering rows in the data viewer

Status: **design settled 2026-11-16 (all seven recommendations accepted, section 8). S1a (sorting), S1b (filters), S2 (the server), S3a (the sort screens) and S3b (the filter panel) are built, and S4 (the documents and version 1.3.0) is prepared. Publishing is the owner's step.** This is the part of milestone M4 that `docs/data-viewer-plan.md` (decision 6, section 5.3) left for its own design, because it lets the browser's choice of column and value shape the `SELECT`. The decisions are in section 8. Numbers in section 2 were measured on 2026-11-16 on one machine; they show shape, not guarantees.

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

The `kind` of a column comes from the catalog, once, with the column list: **text** is the string category (`text`, `varchar`, `char`, `name`); **ordered** is any other type with a default btree operator class (numbers, dates and times, booleans, uuid, enums, ranges; domains count as their base type), except `jsonb` and `bytea`, whose order means nothing to a person; **other** is everything else (`json`, `jsonb`, `xml`, arrays, composites, `bytea`, geometric types).

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

A read with a sort or a filter runs with a statement timeout of **5 seconds** (a plain page keeps the existing 15). The transaction wrapper gains an optional timeout for the call. When a read is stopped, the person sees a fixed message and a new error code, `too_slow` (the same name in the core and in the API, which keeps the two lists in step):

> This took longer than 5 seconds, so it was stopped. On a large table, sort or filter by a column that has an index, or narrow the filter.

Five seconds is chosen from section 2: unindexed sorts and equality stay far below it up to millions of rows, and `contains` crosses it at a few million rows of wide text, which is the case worth stopping. The existing rule of one running read per connection (three waiting, then `429 rows_busy`) bounds the load of repeated tries. The message names no table, column or value.

### 4.7 Where the work goes

| Layer                       | Change                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database-core`    | `RowsOptions` gains `sort` and `filters`; `RowColumn` gains `kind`; the page echoes what was applied; the cursor gains the sort value; validation of both against the column list. |
| `packages/postgres-adapter` | Column `kind` from the catalog; the query builder with the fixed grammar; the shorter timeout; the sort-value limit and its note.                                                  |
| Mock and contract tests     | The mock sorts and filters the sample data the same way; a shared contract block, so mock and PostgreSQL agree (NULL placement, ties, case).                                       |
| `packages/shared-types`     | The two request keys, `kind` and the echo in the response, the `too_slow` code.                                                                                                    |
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

| #   | Milestone                                                                                                                                                                                                                                                         | Size |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| S1  | **Adapter and core**, in two steps. **S1a (built):** column `kind`, sort with keyset paging and NULLs, the shorter timeout, the generated grammar test, mock and contract. **S1b (built):** filters, on the same builder and cursor                               | L    |
| S2  | **Server (built)**: the schema keys, route tests, security rules (the `too_slow` code and its status, 422, arrived with S1a because the build needs every core code in the API list)                                                                              | S    |
| S3  | **Screens**, in two steps. **S3a (built):** the sort headers, the ordering note and the paging state. **S3b (built):** the filter panel and chips, the "no match", "too slow" and "invalid value" states. Each step has its accessibility audit and browser tests | L    |
| S4  | **Documents**: this plan's findings, the threat model and getting-started text, the changelog for the release it ships in                                                                                                                                         | S    |

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

## 11. What S1a found (sorting in the core and the adapter, 2026-11-16)

S1 was split in two so each pull request stays reviewable: S1a is sorting, S1b is filters (decision 1 already said sort first).

1. **The sort value belongs in the cursor, and it can be NULL.** A keyset cursor now holds the last row's key and, for a sorted page, the last row's value in the sort column: `{k: [...], s: [value or null]}`. NULL and the empty string stay different. The decoder accepts only the shapes `{k}`, `{k, s}` and `{o}`. Ascending puts NULL last and continues with `value > last OR (value = last AND key > last key) OR value IS NULL`; descending (NULL first) drops the last clause; after a NULL the two forms are different again. Every form is walked page by page on a real server (each row exactly once, at 1 to 13 rows per page, in both directions), and removing one clause from the statement fails six of those tests.
2. **A cursor can outgrow its limit.** Key values (up to 3,000 characters each) plus a sort value (up to 1,024) can exceed the 4,096-character cursor limit. The page then ends with `sortValueTooLong` instead of producing a cursor the next request would refuse. The sort value is read one character past what a cursor can carry, to tell a value that fits from one that does not.
3. **`jsonb` and `bytea` are "other".** Both have a btree order, so a catalog test for "has an order" calls them sortable. It means nothing to a person, so they are named out (section 4.2). Arrays and composites have a btree class over a pseudo-type (`anyarray`, `anyrecord`) that the same test does not match, so they stay "other" without being named. Enums and ranges also order through pseudo-types and are named in. Domains are followed down to their base type, including a domain over a domain.
4. **The generated grammar test is the guard for "no text typed by the user becomes SQL".** 400 random requests, with names such as `"; DROP TABLE users; --`, `$1`, emoji and 63-byte names, must produce a statement that matches a written grammar once quoted names are replaced; no value of the request may appear outside a quoted name; and every parameter must be used (PostgreSQL refuses an unused one). Making the builder paste a sort value into the text fails it.
5. **The timeout is tested with a lock, not with a slow query.** A sorted read needs a key, so a view with `pg_sleep` cannot be sorted. Another session holds `ACCESS EXCLUSIVE` on a table; the read waits on it and the statement timeout cancels it (SQLSTATE 57014). A sorted read reports `too_slow`; the same read without a sort reports `timeout`; and the adapter works again once the lock is gone. The adapter test runs with a 700 ms limit, because the limit is the smaller of 5 seconds and the adapter's own statement timeout.
6. **The error code is `too_slow`, in the core and in the API**, not `rows_too_slow`: the API's list of codes must contain every core code (a type test keeps them in step), so one name serves both. Status 422.
7. **A hidden column is refused with the same message as any other bad request**, and the message never repeats the column name (tested). The shape of a sort request, whether the column exists, whether it is hidden, whether its type orders, and whether the table has a key are all checked in one pure function used by both adapters.

## 12. What S1b found (filters in the core and the adapter, 2026-11-16)

1. **The operator lookup must use the table's own keys.** The builder chooses the operator's SQL from an object keyed by the operator's name. A plain object also answers to `toString`, `constructor` and `__proto__`, so a name that never reaches the builder in practice (validation refuses it) would have been accepted by the builder itself. A builder test found it; the lookup now uses `Object.hasOwn`. The same applies to any table keyed by a name that came from outside.
2. **Typed comparison does the work, and a value that does not fit is already handled.** `"c" = $n` lets PostgreSQL type the parameter from the column, so numbers compare as numbers (9 before 10), a numeric compares by value (`5.000` equals `5`), an enum compares in its declared order, and a value that does not fit (text for an integer, `5.0` for an integer, a bad date, an enum label that does not exist) raises a data exception that the adapter already turned into a fixed `invalid_request`. Tested for five types, and none of the messages repeats the value.
3. **"Not equal" matches NULL.** `IS DISTINCT FROM` makes a NULL distinct from any value, which is what people mean by "not Ann"; a plain `<>` would drop every NULL silently. A comparison (`>`, `<`, `=`) never matches NULL. The contract tests pin both.
4. **No wildcards, by construction.** `contains` and `starts with` are `strpos(lower(...))` and `starts_with(lower(...))`, so `%`, `_` and `\` in a value are ordinary characters and nothing is escaped. Rewriting `contains` as an `ILIKE` pattern fails four tests (`%`, `_`, `\` and `a%b`), so the property is guarded.
5. **A filter does not change the paging.** The keyset cursor and the offset are the same; the person's conditions are simply required in the `WHERE` next to "after the last row". A filtered, sorted, keyed table is walked page by page at 1 to 5 rows per page and gives the same rows, once each, as one big page; a table without a key is filtered and paged by position. The browser must still start again from the first page whenever the conditions change (S3), because a cursor from one set of conditions means nothing under another.
6. **Only the columns that are read can be used.** In a table of 101 columns, the 101st is refused for a condition (it was not read), and a hidden column is refused until it is revealed, for every operator including the null tests.
7. **The mock is only as typed as its data.** It knows numbers from text by the type names the sample data uses, so it refuses a non-number for a number the way PostgreSQL does at bind time; it cannot refuse a bad date or enum label. Those cases are covered against real PostgreSQL, not by the shared contract.
8. **The shorter time limit applies to a filtered read as well**, checked with the same lock technique: the read is `too_slow`, and the adapter works again afterwards.

## 13. What S2 found (the server, 2026-11-16)

1. **The server adds almost nothing, and that is the point.** `POST /api/connections/:id/rows` gains two optional keys, `sort` and `filters`, and the service passes them to the adapter untouched. Everything that decides what is allowed (the table, the hidden columns, the kind of each column, the operators) already lives in one place, the adapter, so the route cannot disagree with it. A rule test checks that the service builds no text from either key.
2. **Strict all the way down.** The request, the sort and each condition are `strictObject`s; the operator is an enum, never text; a value is at most 200 characters; the two null tests take no value and every other operator needs one (an empty string is a value); up to three conditions. A shape that is wrong is a `400 validation_error` before anything reaches the adapter; a shape that is right but not allowed for this table (a hidden column, a column that does not exist, `contains` on a number, a value that does not fit the type, a cursor from a different sort) is a `400 invalid_request` from the adapter. Neither answer repeats a column name or a value, which a route test checks with distinctive strings, including in the log.
3. **The same refusal while data access is off.** A read with a sort or conditions is refused with exactly the answer a plain read gets, for a table that exists and one that does not, before the adapter is asked. A route test compares the bodies.
4. **Two lists that must not drift.** The schema's operator list and limits (3 conditions, 200 characters) are written out in `shared-types`, which does not depend on the core. A test imports the core's `ROW_FILTER_OPS`, `ROWS_MAX_FILTERS` and `ROWS_MAX_FILTER_VALUE_CHARS` and fails if either list or number differs.
5. **A value must not travel into a log through an error.** A driver message such as `invalid input syntax for type integer: "..."` carries the value; the route answers a fixed `unexpected` and logs the code only. A route test throws such a message and asserts the value is in neither the response nor the log; a stopped read (`too_slow`, 422) is answered with its fixed sentence and its cause is never shown.
6. **New rules in `tests/security.test.ts`.** The request, the sort and each condition are `strictObject`s and the operator is `z.enum(ROW_FILTER_OPERATORS)`; the service passes `sort` and `filters` through with no template literal, `JSON.stringify`, `.join(` or concatenation; the adapter writes each operator from one table by its own keys, uses no `LIKE`, `ILIKE`, `SIMILAR TO` or regular-expression operator, and passes every condition value through the parameter function; no sort or condition type appears in the workspace, snapshot or profile schemas or in a store, the autosave or the canvas code. Putting `ILIKE` in the statement code, and loosening the condition schema, each fail a rule.

## 14. What S3a found (the sort screens, 2026-11-16)

1. **The page number moves before the rows do.** The paging state changes the moment a header or "Next" is activated, and the page being left stays on screen, dimmed (`aria-busy`), until the next one arrives, so "Page 2" and the old rows are visible together for a moment. That is the right behaviour for the person, and it is a trap for a test: reading the rows as soon as the page number changes reads the old page. The browser tests wait for `aria-busy` to clear before they read; two of them failed on this before they did.
2. **A header is a button inside a column header.** A sortable column has `aria-sort` on its `th` (ascending, descending or none, as the database orders it) and a button named "Sort by city" with a ⇅, ↑ or ↓ icon; its tooltip says what the next activation does (sort ascending, sort descending, remove the sort). A column that cannot be sorted has no button and **no `aria-sort`** (the attribute would promise something the column cannot do), and a tooltip that says why: hidden ("Show it first"), no primary key or unique index, or a type with no useful order. The reasons come from one pure function, `whyNotSortable`, next to the core's `canSortRows`.
3. **Every change of order starts again from page 1.** A cursor made for one order means nothing under another, so a new sort, or removing one, empties the trail of cursors. Asking for the sort that is already set changes nothing and keeps the page. Changing the page size keeps the sort, and changing the sort keeps the page size.
4. **Hiding a column again drops a sort on it.** A hidden column cannot be sorted, so the sort goes with it, the page starts again, and the note under the grid goes back to the key order. Hiding a different column leaves the sort and the page alone. Tested in the reducer and in the browser.
5. **The note says what the database did.** "Ordered by score (ascending, NULL last), then by id (the primary key)." comes from the page the server answered, not from what was asked for; descending says "NULL first". A page that ends on a value too long to continue from says paging stops there and what to do.
6. **The sort lives in the paging state and nowhere else.** It is part of the reducer's state, which is React state in `use-rows`; a browser test checks that no key of it reaches `localStorage` or `sessionStorage`, and that another table starts unsorted.
7. **Audit.** Axe finds nothing on the Data section with a sorted grid in light or dark; the sort controls are keyboard operable (Tab to the header, Enter or Space).

## 15. What S3b found (the filter panel, 2026-11-16)

1. **The panel must survive a failed read.** A condition the database refuses (a value that does not fit the column) makes the read fail, and the page being shown is then the last good one. The filter panel and the chips stay on screen above the error, so the condition that caused it can be removed; an error screen that replaced the whole section would have trapped the person in a state they could only leave by reloading. The Next button is disabled while the read is failed, and Previous still works. Only a first read that fails has no page to build a panel from, and shows the plain error.
2. **Plain words, never the database's.** A refused filter says "That value is not valid for this column's type, or the condition is not allowed for it. Change the value or remove the filter." The adapter's `invalid_request` has a fixed sentence about page sizes and paging positions that would be wrong here, so the screen chooses its own sentence when filters are on. A read stopped by the 5 second limit shows the server's fixed sentence and offers to remove the filters (and the sort). A browser test checks that the alert contains neither PostgreSQL's "invalid input syntax" nor the value that was typed.
3. **Derived state, not effects.** The panel keeps only what the person chose (a column name, an operator, a value). The column that is really in force, and the operator that goes with it, are worked out on every render: a column that stopped being usable (hidden again) falls back to the first one that is, and an operator the new column does not have falls back to its first. There is no effect that "fixes" state after the fact, so the panel cannot show a combination that does not exist.
4. **What may be added is decided in one pure function.** `canAddFilter` says whether the column, the operator and the value are acceptable and, when not, in one sentence: at most three; choose a column; not available for this column; a value of at most 200 characters; type a value. The empty string is a value for a text column (rows whose text is empty) and never for another type.
5. **The estimate goes while a filter is on.** "Page 1 · about 1.2 M rows" describes the table, not the matches, so it becomes "Page 1 · filtered"; no count is ever run.
6. **Removing a chip must not lose the keyboard.** The chip is destroyed by the click, so focus moves to the Filter button (tested); "Clear all" does the same. An empty result says "No rows match these filters." (or "There are no more rows that match." beyond the first page) with the chips still there.
7. **Every change of the conditions starts again from page 1**, adding, removing or clearing, because a cursor made for one set of rows means nothing under another. Hiding a column again drops every condition on it together with a sort on it, and starts again only if something was dropped.
8. **Test traps.** Next.js adds its own empty `role="alert"` for route changes, so a locator for the error must be scoped to the Data section; and a connection named "Filter shop" matched the "Filter" button. Both showed up as failures of setup, not of the feature.
9. **Audit.** Axe finds nothing on the Data section with the panel open, with three chips, and with the refusal showing, in light and dark; the panel works from the keyboard (open with Enter, type, submit with Enter).
