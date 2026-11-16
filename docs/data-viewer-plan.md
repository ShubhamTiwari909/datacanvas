# Plan: read-only data viewer

Status: **M0 to M3 done, M4 polish done (2026-11-16); sort/filter and foreign tables not started.** The eight decisions are settled (section 12), the wording of the changed promises is agreed (Appendix A), and the adapter layer, the server layer and the screens are built and tested (sections 15 to 18). The product can now show rows (opt-in, off by default), but **it is not released and its documentation still says it reads none**; those change at M5. Implementation continues with sort and filter (its design is settled in `docs/data-sort-filter-plan.md` and ships as 1.3.0 after the 1.2.0 release), so **M5 is next**. M0 changed three things in the first draft (section 14); M1 to M4 found more (sections 15 to 18).

## 1. Goal

Let a person look at the **rows** of a table, view or materialized view from inside DataCanvas, read-only, without leaving the portal: the first rows, paging through the rest, and the full value of a long cell. It answers "what does the data in this table actually look like?" right next to the structure that explains it.

It is deliberately **not** an editor and **not** a SQL console. Editing rows is a separate, later decision with a much larger risk (see section 13).

## 2. Non-goals

- Writing anything: no update, insert or delete, and no way to run SQL typed by the user. The "no arbitrary SQL" rule stays.
- Exporting rows (CSV, JSON, clipboard of a whole table) in the first version.
- Row counts by scanning (`COUNT(*)`). Only the planner's estimate is shown.
- Searching or filtering across the whole table in the first version (see milestone M4).
- Reading remote data through foreign tables in the first version.

## 3. What changes, and what must not

DataCanvas's strongest promises today are that it reads **structure only**, that every query runs in a **read-only transaction**, and that there is **no arbitrary SQL**. Only the first one changes.

| Promise today                               | After this feature                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Only metadata is read, never table rows     | **Changes.** Rows are read only when the user has switched on data viewing for that connection. Off by default.             |
| Every query runs in a read-only transaction | **Stays**, including for row reads (`BEGIN READ ONLY` plus the statement timeout).                                          |
| No arbitrary SQL, ever                      | **Stays.** The server builds one fixed shape of `SELECT` from catalog-checked names and bound parameters.                   |
| Nothing leaves the machine                  | **Stays.** Rows go from the database to the local server to the local browser, and nowhere else.                            |
| Rows never appear in logs or files          | **New explicit rule:** rows are never logged, saved, put in a workspace or snapshot, cached, or echoed in an error message. |

Because the first promise changes, the README, `SECURITY.md`, the threat model and the wording inside the app all have to change **with** the feature, not after it (section 11).

## 4. Guardrails (the rules the design is held to)

1. **Opt-in per connection, off by default**, visible while on, and switchable off at any time.
2. **Read-only enforced by the database**, not by our code: the existing read-only transaction.
3. **Structured queries only.** Identifiers come from the catalog and are quoted; every value is a bound parameter; the shape of the query never depends on user text.
4. **Bounded everywhere:** rows per page, columns per page, characters per cell, bytes per response, time per query.
5. **Sensitive-looking columns are not sent by default** (server-side masking, section 5.6).
6. **No persistence of rows anywhere**, in memory in the browser only, gone on navigation or disconnect.
7. **Fixed error messages.** A PostgreSQL error message can contain row values (for example "invalid input syntax for type integer: ..."), so the raw message is never returned, which is already the rule for every other error.

## 5. Design

### 5.1 Opt-in model

A connection gets one boolean, `dataAccess`.

- **Where it is chosen:** a checkbox in the connect dialog ("Allow viewing table data: DataCanvas will read rows") and a switch on the connection in the sidebar for changing it later.
- **Where it lives:** in the connection registry entry (memory) so the server can enforce it, and **remembered in the saved profile** as a non-secret flag (decision 1). The saved-connections file is versioned (version 1 today), so this is a **format bump to version 2** with a migration that sets the flag to off for every existing profile. A connection reopened from a profile gets its flag back; workspaces, snapshots and `run.json` never carry it.
- **Enforcement:** the rows endpoint refuses with a clear error when it is off. The UI hides the data section behind an explanation and an "Enable" button.
- **Honesty about what it is:** this is consent and a speed bump, **not** protection against someone who already holds the session token, since that person can switch it on. The token, Host and Origin checks remain the real boundary.
- **Visible state:** a small "Data access: on" badge on the connection and in the data section.

### 5.2 Building the query

One fixed shape, built on the server from validated parts:

```sql
SELECT left("col1"::text, $N) AS c0, left("col2"::text, $N) AS c1, ...
FROM "schema"."table"
[WHERE ("k1", "k2") > ($1, $2)]
ORDER BY "k1", "k2"
LIMIT $L
```

- **Identifiers:** the schema, table and every column are first checked to exist (the same way `table-details` checks), then quoted. The select list is built from the catalog's column list, never from client-supplied names. **Quoting lives in `database-core`** (`quoteIdentifier`): the only `quoteIdent` today is in `apps/web/lib/sql-text.ts`, which the adapter package cannot import. The web app's file then re-exports the shared one, so there is a single implementation and a single test of awkward names.
- **Values as text:** casting every column to `text` in the database avoids driver type surprises (dates, numerics, `bigint`, enums, ranges, JSON, arrays, composites) and lets truncation happen **in the database**, so a multi-megabyte value never crosses the wire. Fetching `N + 1` characters tells us whether a cell was truncated. NULL stays NULL (`left(NULL, n)` is NULL), so NULL and the empty string stay distinguishable.
- **Aliases by position** (`c0`, `c1`, ...) so odd column names (quotes, emoji, 63-byte names, SQL words) can never become an alias problem.
- **Parameters, not text, for values:** the page size and the paging cursor are bound parameters. PostgreSQL infers the parameter type from the column it is compared with, so no cast text is ever concatenated into the SQL.

### 5.3 Ordering and paging

- **Default order:** the primary key; if none, a unique, non-partial index whose columns are all NOT NULL; if neither exists, no `ORDER BY`.
- **Keyset paging** (`WHERE (key) > (last key)`) for tables with such a key: stable, and as fast on page 1000 as on page 1. The cursor is opaque to the browser (the last row's key values as text, encoded) and treated as untrusted input: validated for shape and length, and used only as bound parameters, so tampering can only change where the page starts. **The key values for the cursor are selected separately and untruncated** (hidden columns `k0`, `k1`, ... next to the displayed cells): a displayed cell is cut by `left()`, and a cursor built from a cut value would page wrongly. Key values are bounded anyway (a btree entry cannot exceed about 2.7 KB), and the cursor is capped at 4 KB. Text output of every type reads back as the same value on PostgreSQL 12 and newer (floats print their shortest exact form), so the round trip through a text parameter is exact; a test covers floats, timestamps with time zone, `bytea`, `uuid` and composite keys.
- **Tables without a usable key:** `OFFSET` paging with a hard cap (for example the first 10,000 rows) and a visible notice that the order is not guaranteed. Without a cap, deep `OFFSET` is a full scan.
- **Previous page:** the browser keeps a stack of cursors it has already seen; "Next" and "Previous" only. No "jump to page N".
- **Sorting by another column and filtering:** not in the first version (milestone M4), because they need composite keyset paging and a policy for expensive scans.

### 5.4 Limits (starting values, to be tuned)

| Limit                               | Value                                              |
| ----------------------------------- | -------------------------------------------------- |
| Rows per page                       | 25, 50 (default), 100, 200                         |
| Columns per request                 | first 100 (a notice for wider tables)              |
| Characters per cell in the grid     | 200 shown, 2,000 fetched; a cell opens in a dialog |
| Response size                       | about 2 MB, then the page is cut and says so       |
| Query time                          | the existing 15 second statement timeout           |
| Concurrent row reads per connection | 1 (the pool already allows 3 connections)          |

### 5.5 What kinds of tables

- **Tables, partitioned parents, materialized views:** supported.
- **Views:** supported (a view can be slow; the timeout protects).
- **Foreign tables:** **disabled in the first version.** A read goes to another server, can be slow, and uses credentials we know nothing about. Revisit later with a warning.
- **Row-level security:** the database silently returns fewer rows. We already read the policies, so the data section says "row-level security is enabled on this table; you may not see every row".
- **No `SELECT` privilege:** a clear "permission denied" message (no raw database text).
- **Zero-column table:** an empty grid with an explanation.

### 5.6 Masking (server-side)

Columns whose names look sensitive (`password`, `passwd`, `secret`, `token`, `api_key`, `private_key`, `credential`, `salt`, and similar) are **not selected at all** by default: the server returns a marker instead of the value, so the secret never reaches the browser. The user can reveal a column for the current view, which re-queries with that column included (the choice is kept in memory only).

Masking by name is a **convenience, not a security control**: names are only a hint (a column called `notes` can hold a password, a column called `token_count` is harmless). The documentation must say so. Doing it on the server rather than hiding values in the browser is what makes the default meaningful.

### 5.7 Showing the data

- A **Data** section on the table details view, next to the structure sections (and reachable from the inspector).
- A real `<table>` with a caption, sticky header, monospace values, NULL shown distinctly from the empty string, long values truncated with an ellipsis, a masked-column marker, and Next / Previous plus a page-size select.
- Click a cell for a dialog with the full value (up to the fetch limit), a copy button, and a note when it was cut.
- Estimated row count from the existing estimate ("about 1.2 M rows"), never a scan.
- Loading, empty, error and "access is off" states, in light and dark themes.
- Accessibility: keyboard focus on cells, labels for the controls, announced loading and error states.

## 6. Changes by layer

| Layer                           | Change                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database-core`        | New model `RowPage` (columns, cell values as text or null with a truncated flag, masked column names, next cursor, ordering description). New adapter method `getRows(ref, options)`. The comment that says the adapter returns structure only is rewritten to say what is true now. Also gains the shared `quoteIdentifier`. |
| `packages/postgres-adapter`     | New `introspection/rows.ts` (query builder, key discovery, truncation, paging) running through `withReadOnlyTransaction`. Unit tests of the query text and parameters.                                                                                                                                                        |
| Mock adapter and contract tests | Mock `getRows` over the sample data; a shared contract block so the mock and PostgreSQL behave the same.                                                                                                                                                                                                                      |
| `packages/shared-types`         | Request and response schemas for rows (bounded), the new API error codes (`data_access_disabled`, and a clear permission code), and the `dataAccess` field on the connection summary and the saved profile (connections file version 2, with a migration that defaults it to off).                                            |
| `apps/web` server               | `ConnectionRegistry` entry gains `dataAccess`; `ConnectionService.getRows` checks it; a route to read rows and a route to switch the flag. All inside `handleRoute` (already guarded). `Cache-Control: no-store`. Bodies are JSON (POST) so identifiers and cursors never appear in URLs, history or logs.                    |
| `apps/web` UI                   | Connect-dialog checkbox, sidebar switch and badge, Data section and cell dialog, in-memory state only (no persisted store, never in workspace autosave).                                                                                                                                                                      |
| Docs and tests                  | Section 11 and section 8.                                                                                                                                                                                                                                                                                                     |

## 7. Security and privacy analysis

New asset: **the contents of the user's tables**. The local server is still reachable only from the machine, only with the per-run token, and only with a matching Host and Origin, but what an attacker would get by passing those checks is now far more valuable.

| Risk                                                | Mitigation                                                                                                                 | Left over                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A web page or local program calls the rows endpoint | Existing Host, Origin, `Sec-Fetch-Site` and token checks, in the proxy and again in every route; the per-connection opt-in | Anyone holding the token can switch the flag on. Same trust level as before, higher stakes. |
| Rows leak through logs                              | Never log request bodies, cursors or rows; only error codes (already the rule)                                             | A new test asserts no cell value reaches the console                                        |
| Rows leak through error messages                    | Raw database messages are never returned (they can contain values)                                                         | None known                                                                                  |
| Rows saved to disk                                  | Not stored anywhere: not in workspaces, snapshots, `run.json` or profiles                                                  | The browser's own memory and swap                                                           |
| Rows cached                                         | `Cache-Control: no-store`; POST bodies                                                                                     | Browser extensions with page access                                                         |
| Shoulder surfing or screen sharing                  | Optional "blur values" toggle (M4)                                                                                         | The user shares a screen                                                                    |
| Secrets shown by accident                           | Server-side name-based masking                                                                                             | Names are only a hint                                                                       |
| A query that hurts the database                     | Read-only transaction, statement timeout, row and size caps, one read at a time, keyset paging, capped `OFFSET`            | A slow view or heavy table still costs the database up to the timeout                       |
| SQL injection through names or cursors              | Names come from the catalog and are quoted; values and cursors are bound parameters; tested with the awkward-names fixture | None known                                                                                  |
| Wrong data shown                                    | Text conversion in the database, NULL kept distinct, truncation flagged                                                    | A value cut at the limit is labelled as cut                                                 |

The threat model gains an "asset: table rows" entry, the new attacker attempts above, and the residual risks, and `SECURITY.md` replaces "never reads table rows" with the accurate statement.

## 8. Testing plan

- **Unit:** query builder (identifier quoting, select list, key discovery order, cursor encoding and validation), masking rules, limits, truncation flag, the response schema bounds.
- **Adapter integration (real PostgreSQL), on the existing awkward-schema fixture:** quoted, Unicode and reserved-word names; the 63-byte name; 301 columns (the 100-column cut); a zero-column table; enum, domain, composite, array, range, `jsonb`, `bytea`, `inet`, `numeric`, `timestamptz`; a very large text value (truncated in the database); a partitioned table; a view and a materialized view; a foreign table (refused); a role without `SELECT` (permission error, no raw text); a table with row-level security; keyset paging forward and back across a composite primary key and across NULLs; a table without a key (capped `OFFSET`).
- **Security rule tests (`tests/security.test.ts` style):** the rows route is guarded; it refuses when `dataAccess` is off; no route path suggests SQL; no code writes cell values to the console; rows do not appear in error responses (including a deliberately bad cursor and a value that makes PostgreSQL's own message contain the value).
- **Promise tests:** a snapshot and the structure never contain row data (the strict schemas reject a `rows` key), and capturing a structure or a snapshot never calls `getRows` (checked with a spy on the mock adapter); the profile migration from version 1 sets the flag to off and an old file still opens; keyset paging on a table whose key is a long text value (longer than the grid's 200 characters) pages correctly.
- **Version matrix:** the new adapter tests on PostgreSQL 12 to 18 through `npm run test:pg-matrix`.
- **End to end (Playwright):** turn data access on and off; see rows; page forward and back; masked column and reveal; open a long cell; a table with awkward names; the "off" explanation; dark mode; no rows in the page after disconnect.
- **Performance:** first page of a table with a few million rows is fast (keyset, no count); a wide table; a table with huge values.

## 9. Milestones

Sizes are relative (S, M, L), not time estimates.

|     | Milestone                                                                                                                                                             | Size | Done when                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | **Decisions and wording**: settle section 12; agree the wording of the promises that will change (Appendix A). **Done 2026-11-16.**                                   | S    | The open decisions are answered and the new wording is agreed                                                                                                                                                                                |
| M1  | **Adapter**: model, `getRows` in the interface, PostgreSQL implementation, mock, contract and awkward-schema tests, matrix                                            | L    | All adapter tests pass on PostgreSQL 12 to 18 **Done 2026-11-16.**                                                                                                                                                                           |
| M2  | **Server**: `dataAccess` flag, service, routes, error codes, schemas, route and security rule tests                                                                   | M    | A disabled connection cannot read rows; no value reaches a log or error **Done 2026-11-16.**                                                                                                                                                 |
| M3  | **UI v1**: opt-in flow, Data section, paging, masking and reveal, cell dialog, themes, Playwright tests                                                               | L    | The end-to-end flow passes; checked by eye in light and dark **Done 2026-11-16.**                                                                                                                                                            |
| M4  | **Polish and extras**: sort and filter (composite keyset, timeout-aware), blur toggle, RLS notice, optional foreign-table support, performance and accessibility pass | M    | Performance numbers recorded; accessibility issues fixed **Polish done 2026-11-16 (blur, RLS notice, accessibility and performance); sort/filter is designed in `docs/data-sort-filter-plan.md` (not built); foreign tables are split out.** |
| M5  | **Release**: docs, changelog, minor version, publish checklist                                                                                                        | S    | Release gate green; version bumped (1.2.0 suggested)                                                                                                                                                                                         |

Each milestone ends with `npm run check`, the browser tests and the tarball test, and each is a separate commit.

## 10. Risks of the project itself

- **Trust:** the project's pitch is "safe to point at anything". The feature must be opt-in and the wording honest, or it damages that trust. Mitigation: off by default, visible, documented, and the read-only guarantee kept.
- **Scope creep toward an admin tool:** sort, filter, export, edit, SQL box. Mitigation: this plan names what is out and why; each addition needs its own decision.
- **Type surprises:** PostgreSQL has many types. Mitigation: everything is read as text in the database, and the fixture covers the awkward ones.
- **Performance traps:** counts, deep `OFFSET`, wide rows, huge values. Mitigation: no counts, keyset paging, hard caps, database-side truncation.
- **Privacy regressions later:** a future change could log or persist rows. Mitigation: tests that fail if rows reach logs, files or error text.

## 11. Documentation to update (in the same change)

Two kinds of text mention rows, and they need different treatment.

**Product-wide promises: these change with the feature** (the agreed new wording is in Appendix A):

- `README.md`: the "Your database, your machine" bullet that says rows are never read, and the feature list.
- `SECURITY.md`: "What DataCanvas reads from your database", what is stored, the new known limits.
- `docs/threat-model.md`: new asset "table contents", the new attacker attempts, the residual risks.
- `docs/getting-started.md`: how to enable data viewing, what masking means and does not mean.
- `docs/architecture.md` and `docs/decisions.md`: the design, and one decision entry per decision in section 12.
- `docs/development-plan.md`: its two "never read rows" lines describe the original plan; add a pointer to this document instead of rewriting history.
- `CHANGELOG.md`.
- In the app: the connect dialog note (`features/connections/connection-form.tsx`, "never its rows") and the new checkbox.
- The adapter interface comment in `packages/database-core/src/adapter.ts` that says "no method returns table rows".

**Per-feature statements: these stay true, but must say "this tab" and not "DataCanvas".** The Snapshots, Objects, Health and Overview tabs, the snapshot export route, the structure and objects routes and several code comments say "no table rows are read". They describe those features accurately and stay accurate with data viewing on, but as absolute sentences they could be misread. Reword each to "this tab reads no table rows" (template in Appendix A) when the product-wide wording changes, so the two never disagree. A test (section 8) keeps the claim about snapshots true.

## 12. Decisions (settled 2026-11-16)

All eight recommendations of the first draft were accepted. Each entry is the decision and the reason.

1. **Where the opt-in lives: also remembered in the saved profile**, as a non-secret flag, default off, with the visible badge and an easy switch. It matches how the other non-secret settings behave, and reconnecting already asks for the password. Consequence: the connections file moves to version 2 with a migration that turns the flag off for existing profiles.
2. **Where masking happens: on the server.** The server never sends masked columns; hiding values in the browser would mean the secret already crossed to it.
3. **Limits:** 50 rows per page by default (25, 50, 100, 200 selectable), 100 columns, 200 characters in the grid, 2,000 fetched.
4. **Foreign tables: disabled** in the first version.
5. **Views and materialized views: allowed.**
6. **Sort and filter: not in the first release** (milestone M4). Designed separately in `docs/data-sort-filter-plan.md`.
7. **Export of rows: none** in the first version; copying one cell is allowed.
8. **Version number: 1.2.0** (a new feature that changes a documented promise, but off by default).

## 13. Later and out of scope: editing rows

Editing is **not** part of this plan. If it is ever built it needs its own plan, because it removes the read-only guarantee: a write path to the database, an "unlock editing" step beyond the session token, updates by primary key only with a preview and a conflict check, typed validation per column, awareness of triggers and cascades, and a different position for the product. The viewer is designed so that none of this is needed to ship it, and so that adding it later does not require undoing anything here.

## 14. Changes made to the first draft in M0

1. **Identifier quoting moves to `database-core`.** The draft said to use "the existing `quoteIdent`", which lives in the web app and cannot be imported by the adapter package.
2. **The paging cursor uses untruncated key values**, selected separately from the displayed cells, because displayed cells are cut by `left()` and a cursor built from a cut value pages wrongly.
3. **The wording to change is split in two** (section 11): product-wide promises change; per-feature statements stay true and are reworded to "this tab". Also new: the saved-connections file needs a version bump (decision 1), and tests that snapshots and structure capture never contain or read rows (section 8).

## Appendix A. Agreed wording

This is the exact text to use when the feature ships (M2 for the server messages, M3 for the app, M5 for the documents). It is deliberately **not** in the live README or `SECURITY.md` yet: those ship in the npm package and must not describe a feature that does not exist.

**README, "Your database, your machine, your control" (replaces the metadata bullet):**

> - By default only **metadata** is read (names, types, keys, indexes, definitions). If you switch on **Allow viewing table data** for a connection, DataCanvas can also show the rows of a table you open: read-only, one page at a time, never saved, logged or put in a snapshot or workspace. There is no way to run your own SQL.

**SECURITY.md, "What DataCanvas reads from your database" (replaces the paragraph):**

> By default, only **metadata**: schema, table and column names, types, keys, indexes, constraints, comments, definitions of views, functions and policies, usage counters and row-count estimates. Every query runs in a read-only transaction, and there is no way to run your own SQL.
>
> If you switch on **data viewing** for a connection (off by default, shown by a badge, remembered with the saved connection), DataCanvas also reads **rows**: a fixed `SELECT` on a table you open, in the same read-only transaction, with limits on rows, columns, cell length, response size and time. Rows go from the database to the local server to your browser and nowhere else; they are never written to a file, logged, cached, or included in an error message, a snapshot or a workspace. Columns whose names look sensitive (`password`, `token`, `secret`, ...) are not sent unless you reveal them; this is a convenience, not a security control, because names are only a hint. Anyone who holds the session token can switch data viewing on, so treat the printed link like a password.

**Threat model, assets table (new row):**

> | Table contents (when data viewing is on) | The most sensitive asset: whoever can call the API with the token can read rows of tables on an open connection. |

**Connect dialog:**

> Checkbox: **Allow viewing table data**. Help: Off by default. When on, DataCanvas reads and shows the rows of tables you open, read-only. Rows are never saved.
>
> Note (replaces "only reads the structure ... never its rows"): By default DataCanvas reads only the structure of your database. A read-only database user is still the safest choice.

**Per-feature statements (template):**

> This tab reads no table rows.

Use it for the Snapshots, Objects, Health and Overview headers and in the matching code comments and route comments; for snapshots add: "A snapshot never contains rows, whether or not data viewing is on."

**Error messages (fixed text, no database text):** `data_access_disabled`: "Viewing table data is switched off for this connection. Switch it on to see rows." Permission denied: "The database user cannot read this table."

## 15. What M1 found (adapter layer, 2026-11-16)

1. **A materialized view is always read unordered.** Its columns are never `NOT NULL`, so even a unique index on one fails the "every key column NOT NULL" rule that keyset paging needs (a NULL key would break "after the last key"). Section 5.3's key rule is unchanged; the consequence is that materialized views are paged by position, capped at 10,000 rows. Allowing a nullable unique key (ordering with `NULLS LAST` and a null-aware cursor) is possible later and is recorded as a candidate for M4.
2. **Booleans read as `true` and `false`.** Casting to text gives that, not the `t` and `f` that psql prints; the grid shows what the cast gives.
3. **A parameter must be referenced.** PostgreSQL refuses a statement with an unused parameter (42P18). The cell-limit parameter is now only passed when some column uses it, which matters for a table whose every column is masked. Covered by a unit test and an integration test.
4. **Row comparison needs no casts.** `ROW("k1", "k2") > ROW($2, $3)` with untyped text parameters pages correctly for every key type tested (bigint, text longer than the cell limit, composite keys), so section 5.2's rule of binding values without cast text holds.

The paging cursor is plain ASCII (non-ASCII characters are escaped inside it), because `database-core` has no text-encoding dependency; section 5.3 said only that it is opaque.

## 16. What M2 found (server layer, 2026-11-16)

1. **The refusal must not depend on the table.** The check runs before anything is resolved, so a connection with data access off answers the same for a table that exists and one that does not. A test pins this.
2. **The profile file needed a real migration, and a strict reader.** Version 1 files get `dataAccess: false` for every profile; a version 2 file that lacks the flag is refused instead of assumed, so nothing can become readable by a damaged or hand-edited file.
3. **`dataAccess` is a setting of the connection, not part of it.** It is accepted in the connect request next to `remember` and `profileId`, stripped before the connection is resolved (a test checks the resolved object has no such key), and never sent to the database. `ResolvedPostgresConnection` still holds only what the database needs.
4. **Order of writes when switching.** The saved profile is updated before the in-memory setting, so a disk failure leaves both unchanged and the screen cannot show "on" for something that was not remembered.
5. **Concurrency is bounded, not unlimited.** One read runs, three wait, the rest get `429 rows_busy`. The numbers are constants in `rows-gate.ts` and are the ones the plan's "one read at a time" implies once a browser can pipeline requests.
6. **Remembering a database that is already saved keeps the latest choice** (the saved profile was reused by `add` and kept its old flag until this was handled).

## 17. What M3 found (screens, 2026-11-16)

1. **A saved connection did not appear until a reload.** On `main`, connecting with "Save this connection" put the profile on disk but the sidebar's saved list was only read at page load, so closing a connection right after opening it showed no way to reconnect. The opt-in is remembered with the saved connection, so this mattered: the store now fetches the list when a connection is linked to a profile it has not seen. The existing end-to-end test had hidden it by reloading the page.
2. **A grid of thousands of cells cannot have thousands of tab stops.** One cell is focusable at a time (roving tab index); arrow keys, Home, End and Page Up/Down move, Enter opens a value. The end-to-end test uses only the keyboard.
3. **Previous is a stack, not a query.** The server's cursor only goes forward, so the browser keeps the cursors it has shown. Changing the page size starts again from the first page.
4. **The hidden-column promise is testable in the page.** Because the server never reads a masked column, its value cannot be in the DOM; the browser test asserts it is absent from the page's HTML, and that revealing one column does not reveal another.
5. **Rows are checked for in the browser's storage too.** After a disconnect the test reads `localStorage` and `sessionStorage` and asserts no value is there.
6. **The safety rules must ignore comments.** A comment that says "never kept in localStorage" tripped the first version of the rule; it now reads code without comments.
7. **Wording.** The connect dialog note changed with the checkbox, as the plan said. The per-tab statements ("no table rows are read" on Snapshots, Objects, Health and Overview) still say what they said and stay true; they are reworded to "this tab reads no table rows" at M5 with the product-wide text.

## 18. What M4 found (polish: blur, row-level security, accessibility and performance, 2026-11-16)

Scope was settled with the owner: this part of M4 is the small, low-risk items. **Sort and filter, and foreign-table support, are not in it**: they let the browser's choice of column and value shape the `SELECT` and can cause full scans, so they get a short design of their own (which operators, which columns, how scans are bounded) before any code. Decision 6 and 4 stand until then.

1. **Row-level security is a property of the role, not only of the table.** A superuser or a role with `BYPASSRLS` is never subject to it, and a table's owner is not either unless the table `FORCE`s it. A notice on every table with security on would be wrong for exactly the people most likely to be looking (the database owner), so the page carries `rowSecurity: "off" | "applies" | "exempt"` and the note shows only for `applies`. It is read with one catalog query (`relrowsecurity`, `relforcerowsecurity`, `rolsuper`, `rolbypassrls`, `pg_has_role`), no policy and no row, in the same read-only transaction. Tested on a real server for all five cases (off, on and applying, superuser, owner, owner with force) and in the browser for the two that matter (a role it applies to sees one row and the note; the owner sees all rows and no note). Membership in the owner role is judged with `pg_has_role(..., 'USAGE')`, which can differ from what PostgreSQL does for roles that do not inherit, so the wording says "may".
2. **Blur is a view setting held in memory.** One boolean in a store that is never persisted (it starts off on every page load), shared by every table so switching tables does not suddenly show values. In the grid it is a CSS rule driven by one attribute on the grid, so switching it re-renders no cell. The dialog blurs too and says why. NULL, "(empty)" and the hidden-column dots are not blurred: they say nothing about a value. It does not change what is fetched, copied or read by a screen reader, and the documentation must say it is for screen sharing and not a privacy control.
3. **Accessibility audit** (axe-core, which is already installed, run once on the Data section in light and dark with a cell dialog open and blur on). Found and fixed in the Data section: the data type under a column name was 4.3:1 against its header (it needs 4.5:1), and the cell dialog emptied itself the instant it was closed, so for the length of its fade-out it was an empty box with no name. The dialog now keeps its content until the animation ends, then drops it. **Not fixed, outside this feature:** muted text on the muted background elsewhere in the app has the same 4.3:1 ratio (the connection line in the sidebar, the "Name", "Type" and similar headers of the column list), and the page has no level-one heading. Both are in the design tokens and page structure, not in the Data section, and are listed for a separate change.
4. **Performance, measured** (one machine, PostgreSQL 17, tracing off, the widest and longest page the limits allow: 100 columns by 200 rows, 20,606 cells): the page shows in about 1.6 s including the request, the next page takes about 0.35 s, switching blur about 0.4 s, and an arrow-key move about 9 ms (a three-row table: 2 ms). Rows are memoised so a move re-renders the two rows involved. An earlier reading of 75 ms per key press was Playwright's trace recorder walking the 20,000-cell page after every action, not the app; measure these with `--trace off`.
5. **A closing dialog is a real state.** Anything rendered from "the open item" must keep rendering during the exit animation, or it flashes empty and fails the "dialog has a name" rule while it does.
