# Plan: 1.10.0, the insight and housekeeping release (nothing in it writes a row)

Status: **proposed 2026-11-23; the decisions of section 12 were taken by the owner on 2026-11-23 (every recommendation accepted, decision 161).** Written from the state of `main` at 1.9.0 (`d0d75e0`), after the independent reviews of 1.8.0 and 1.9.0 and the lists of known limits in `SECURITY.md` and `docs/threat-model.md`. The write side's next steps are in `docs/write-side-v2-plan.md` (1.11.0); the split follows the rule of 1.8.0 and 1.9.0: **a release that adds no way to change a database does not need the review a release that does need.**

## 1. What we promise

1. **A Content-Security-Policy** on every page, with a per-request nonce for scripts: the biggest open item of `SECURITY.md` since the security phase ("there is no full Content-Security-Policy yet").
2. **A query plan viewer** in the SQL tab: `EXPLAIN` (and `EXPLAIN ANALYZE`) as a tree with the cost, the rows the planner expected against the rows it got, the time and the buffers of each step, and the step that deserves the eye. Today the tab shows the plan's text.
3. **Column and table statistics** in the table details: how many values are NULL, how many distinct, how wide, how well ordered, how big the table is and when it was last vacuumed and analysed, read from the server's own statistics without reading a row.
4. **Documentation and diagram exports**: a Markdown data dictionary of a schema or the whole database, and the canvas as **Mermaid** (`erDiagram`), **DBML** and **PlantUML**, made in the browser from the structure already in memory.
5. **Export the rows you chose** (the selection of 1.9.0) and **export as a script of `INSERT` statements**.
6. **Housekeeping**: the small findings that the reviews of 1.8.0 and 1.9.0 accepted or left, the patch updates of the dependencies, and the files that should not be there.

What we do not promise: an activity and locks view (the text of other sessions' queries can hold values; section 10), a major upgrade of ESLint, TypeScript or React Flow (each is its own change), or anything that writes.

## 2. What we already have (and reuse)

- **`proxy.ts`** is the front door of every request (`apps/web/proxy.ts`) and already sets the host, origin and cookie checks; `next.config.ts` sets the other security headers (`frame-ancestors 'none'`, `nosniff`, `no-referrer`, the resource and opener policies). The app is **one page** (`app/page.tsx` under one layout), so a nonce costs one dynamic render, not a rewrite.
- **The SQL runner** (1.6): a connection of its own per run, a read-only transaction, a deadline, a cancel that cancels, and an Explain menu that runs `EXPLAIN ` and `EXPLAIN (ANALYZE, BUFFERS) ` in front of a plain query (the runner refuses `EXPLAIN ANALYZE` of what PostgreSQL's read-only check does not stop, decision of the 1.6 review).
- **The structure model** (`ColumnInfo`, `ConstraintInfo`, `IndexInfo`, `RelationshipInfo`) that the canvas, snapshots and migrations are drawn from; the canvas's `export-image.ts` for PNG and SVG; `features/data/export-file.ts` and `database-core/rows-export.ts` for the row formatters (CSV, TSV, JSON, NDJSON, the leading apostrophe).
- **Selection by key** in the Data section (1.9.0): rows chosen across pages, each with the values the person saw.
- **`index-usage.ts`**: an existing read of `pg_stat_*` counters, which statistics follow in style and in tests.

## 3. The design in one page

| Feature                | Where the work happens                                                                                                            | New route                                | Reads rows?          | Needs writes unlocked |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------- | --------------------- |
| CSP                    | `proxy.ts` makes a nonce and the header per request; the layout passes the nonce to the framework's scripts                       | none                                     | no                   | no                    |
| Plan viewer            | Browser parses the JSON plan the runner already returns (one JSON column); the runner already accepts the option (a test pins it) | none (the SQL run route)                 | as the SQL tab does  | no                    |
| Statistics             | Adapter reads `pg_stats`, `pg_stat_user_tables`, `pg_class` by names from the catalog; **never** `most_common_vals` or histograms | `GET .../tables/:table/statistics` (new) | **no**               | no                    |
| Documentation exports  | Browser only, from the structure in memory                                                                                        | none                                     | no                   | no                    |
| Export of chosen rows  | The export route takes a list of keys instead of a filter; the selection moves out of the row-editing hook so it works read-only  | none (`rows/export` takes a bigger body) | yes (as export does) | no                    |
| `INSERT` script format | A formatter in `database-core` next to the CSV one                                                                                | none                                     | yes (as export does) | no                    |

Three rules hold throughout, as in 1.8.0:

- **Nothing here writes.** The statistics, the plan viewer and the documentation exports add no write path; the `INSERT` script is text that DataCanvas never runs.
- **A value never reaches a place it did not reach before.** The statistics leave out the statistics columns that hold values (section 6.3). The plan viewer shows what the person's own statement printed, in the tab's memory, like its results.
- **Every name that ends up in an exported text is quoted for that text** (Mermaid, DBML, PlantUML, Markdown, SQL), with tests that use hostile names.

## 4. The Content-Security-Policy

### 4.1 The policy

Set per request by `proxy.ts` (a header on the HTML response; static files do not need one):

```text
default-src 'none';
script-src 'self' 'nonce-<random>' 'strict-dynamic';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
worker-src 'self' blob:;
object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';
```

- `script-src` takes a nonce that the framework puts on its own inline and loaded scripts when the page is rendered per request; `'strict-dynamic'` lets those scripts load their chunks. In **development only**, `'unsafe-eval'` is added (the dev server needs it); the packaged app never has it.
- `style-src` keeps `'unsafe-inline'`: React Flow and the menus set `style` attributes, which a nonce cannot cover. That is a smaller hole than scripts (no code runs from a style) and is said in `SECURITY.md`.
- `worker-src` has `'self'` for Monaco's editor worker (built into the package) and `blob:` in case a dependency makes one from a blob; the spike (section 4.2) decides whether `blob:` is needed.
- `img-src` has `data:` and `blob:` for the image export and the canvas; `connect-src 'self'` is the API.

### 4.2 The spike comes first (V1)

A **report-only** header (`Content-Security-Policy-Report-Only`) runs through the whole Playwright suite with a listener for `securitypolicyviolation` on every screen (every tab, dialog, the SQL editor, the JSON editor, the canvas export, the file downloads). The milestone ends with a list of what the policy must allow, the policy that passes with no violation, and **a Playwright test that fails on any violation**. Only then does the header become enforcing.

### 4.3 What it costs

The page is rendered per request (it was static): a few milliseconds on a local server. The test for the nonce (a different value on every request, never reused, present on every script of the page) and the test that no script runs without it are part of the milestone. `docs/decisions.md` records what the policy allows and why.

## 5. The query plan viewer

- The Explain menu keeps its two entries and adds a view: the plan is asked as `EXPLAIN (FORMAT JSON)` or `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` (the runner already accepts the options in parentheses after `EXPLAIN` and refuses what is not a plain query or holds `INTO`, `checkExplained` in `database-core/src/sql-run.ts`; V2 pins `FORMAT JSON` with tests, next to the refusals of `EXPLAIN ANALYZE CREATE TABLE ... AS`).
- **The plan travels uncut, by a path of its own.** The runner cuts every cell of a result at 2,000 characters (`cutLongCells`, `run-statement.ts`), which would break the JSON of any real plan. An `EXPLAIN` already has a branch of its own in the runner ("small and cannot be read in pieces"); V2 gives it an **explain budget**: the one cell is kept whole up to **2 MB**, and a larger plan is refused by the runner with a fixed sentence ("the plan is larger than 2 MB: explain a smaller query or read the text"), never cut. Every other result keeps the 2,000-character cut, and a test pins both.
- The browser parses the one JSON cell into a tree, **refusing nesting deeper than 100**, and shows for each node: its type, the relation and the index, the cost, the rows expected and (with ANALYZE) the rows got and the loops, the time, the buffers and the filter text. A node is marked when the planner was wrong by 10 times or more, when it is a sequential scan of a large table, when a sort or a hash spills to disk, or when it holds most of the time.
- **A switch between the tree and the text.** The text stays, because it is what people paste into a chat.
- The plan holds what the person's own statement holds (literals in a filter). The plan stays in the tab's memory, like a result, and is in no file, no log and no store; a rule test pins `features/sql/plan*` outside every store, as for the results. **The statement that was explained is in the tab's history like any statement that ran** (the history holds the text that was sent, in the tab's memory only, decision 131), and so is its literal: the plan adds nothing to that, and the privacy text says it plainly instead of promising that no history holds a literal.
- No dependency: a tree of nested lists with the node's numbers, not a graph library.

## 6. Column and table statistics

### 6.1 What is shown

In the Table details tab, per column: the fraction of NULL, the number of distinct values (PostgreSQL's estimate; a negative figure means "a share of the rows", shown as a percentage), the average width in bytes and the correlation with the physical order. Per table: the size of the table, of its indexes and of its TOAST data; the estimated live and dead rows; the last vacuum, autovacuum, analyze and autoanalyze times; and a note when the figures are old or absent ("never analysed: the planner is guessing").

### 6.2 Where it reads

`pg_stats` (the columns named above), `pg_stat_user_tables` and `pg_class` with `pg_total_relation_size`-family functions, by the table's oid from the catalog. It reads **no row of the table** and takes no lock beyond the catalog's. `pg_stats` shows a column only to a role that may select it, so a restricted role sees fewer columns, and the screen says why a column has no figures.

### 6.3 What it never reads

**`most_common_vals`, `most_common_freqs`, `histogram_bounds`, `most_common_elems`** hold values of the table. They are not read, not named in a statement, and a rule test checks that no query of the adapter selects them (as the hidden-column rules do). Whether the statistics need "Allow viewing table data": **no**, because what remains (a fraction, a count, a width) is the kind of metadata the row-count estimate already is. If the owner prefers the stricter reading, the route sits behind the data-access check with one line (section 11).

## 7. Documentation and diagram exports

- **Markdown data dictionary**, for one schema or all of them: per table its type, its estimated rows, its comment if the structure carries one, a table of columns (name, type, NULL, default, key, references), the constraints and the indexes. Offered from the canvas export dialog, the Overview and a snapshot (a snapshot is structure, so the dictionary of last month's schema is one click).
- **Mermaid `erDiagram`**, **DBML** and **PlantUML** for the tables on the canvas (or all, or one schema), with the relationships and their cardinality (the model already has 1:1, 1:N, N:1).
- All made in the browser by pure functions from the structure in memory: no route, no data, no new capability. The files are made on the person's machine and saved by the browser, as the image export is.
- **Quoting is the work.** A table called `order items`, `a"b`, `x]y` or a name with a line break must give a file that parses: each format has its own quoting (`"..."` doubled in DBML, backticks or quotes in Mermaid and PlantUML aliases, escaped `|` and line breaks in Markdown cells). Golden-file tests per format, tests with hostile names, and a test that every identifier of a sample database appears in each output.
- A Mermaid or PlantUML source is text that a person may paste into a service: the export says what it contains (table and column names, no data) in the dialog, as the image export does.

## 8. Export of the chosen rows, and the `INSERT` script

### 8.1 The chosen rows

**Export chosen needs no write unlock, so it cannot live where the selection lives today:** the selection of 1.9.0 is built inside the row-editing hook and shown only for an editable table with writes unlocked. V5 moves the selection state and the checkbox column to the Data section's own level, so a table can be selected **read-only**, by **the key of the page reader's own paging** (a table with no usable key cannot be selected, and the screen says why, as the editing grid does). The bulk toolbar (Set a value, Delete rows, Import) is still shown only with writes unlocked; **Export chosen** is shown whenever data viewing is on. The selection toolbar of 1.9.0 gets **Export chosen**. The export route takes either a filter (as today) or **a list of keys** (at most 500, the same strict key shape as a bulk change, every value bound, every key column named from the catalog, a key that does not exist simply gives no row). The rows are read by the page reader's own statement with the key condition added, so every rule about hidden columns and cut values applies unchanged, and the formatter, the limits and the cut notes are the export's own. It is **not** done in the browser from the page's cells: a cell is cut at 2,000 characters there, and a file that silently holds half a value is the worst kind of export.

### 8.2 The `INSERT` script

A fifth format beside CSV, TSV, JSON and NDJSON, for a table's rows or the chosen rows:

```sql
-- DataCanvas export: public.people, 120 rows, 2026-11-23T10:00:00Z
-- Columns left out (names that look sensitive): password_hash
INSERT INTO "public"."people" ("id", "full_name") VALUES
  ('1', 'Ann'),
  ('2', 'O''Brien');
```

- **Every value is a quoted text literal** (`'...'` with a quote doubled, the form PostgreSQL converts to the column's type on insert) or `NULL`; **identifiers are quoted from the catalog**; no cast text is built from anything but the catalog's type names, and none is needed for a plain `INSERT ... VALUES`. A value with a backslash needs no escape under `standard_conforming_strings = on` (the default since 9.1): the file says so in a comment and starts with `SET standard_conforming_strings = on;`.
- One statement per 100 rows. **Generated columns** (`GENERATED ... STORED`) are left out, because an insert cannot set them, and the notes say which; the round trip compares every column **except those**. **Identity-always columns are kept**, with `OVERRIDING SYSTEM VALUE` after the column list (PostgreSQL 10 and later), so the copy has the same ids; the sequence is not moved, and a comment at the end of the file says so. A table whose every column is left out writes `INSERT INTO "t" DEFAULT VALUES;` once for each row (the round trip covers it).
- **A script rolls itself back when it is not whole.** The file is `BEGIN; ... COMMIT;`. If it was cut for any reason (the row limit, the 64 MB limit, a cell over the 1,000,000-character limit that the export would shorten, a failure), it ends with a comment that says so and **`ROLLBACK;` in place of `COMMIT;`**, so running a half script changes nothing. Only a complete script commits. A cut value is never in a script that commits.
- **Comments never hold a raw name.** The header comments name the table and the columns left out, and a `--` comment ends at a line break: a table called `x` + a newline + `DROP TABLE y;` must not become a statement. Every name written in a comment goes through one function that replaces every line break and control character (`\n`, `\r`, the other C0 controls, `U+0085`, `U+2028`, `U+2029`) with a space and cuts it at 200 characters; a hostile-name test pins that no line of the file other than the statements and the fixed comments can start with anything but `--`.
- **This is the reason it was left for later** (decision 153.9: "it is another thing to quote correctly"). It is accepted now with a **round-trip test against a real PostgreSQL**: a table with every type the adapter knows and hostile values is exported, the script is run in an empty copy, and the two are compared cell by cell. It runs in CI on PostgreSQL 12 to 18.
- The script is text for the person to run themselves. DataCanvas does not run it, and the SQL tab would refuse it anyway.

## 9. Housekeeping

| Item                                                                                                                                                       | Work                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four stray backup files in the working folders (`*.bk`, `*.bak`, `*.orig`), git-ignored locally                                                            | Deleted by the owner (they are not in the repository); a rule test fails if one is ever tracked                                                                                                                                    |
| Patch updates: Playwright 1.65.1, vitest 5.1.1, lucide-react 1.78, typescript-eslint 8.73, axe-core 4.14.1                                                 | One commit, the whole gate after it                                                                                                                                                                                                |
| `npm audit`: two low advisories, through `monaco-editor` to `dompurify`                                                                                    | The fix offered is a **downgrade** of Monaco, which is refused. Look for a fixed `dompurify` and an `overrides` entry; if there is none, record it as accepted: Monaco's hover and markdown content is ours, never a person's HTML |
| The CSV delimiter is detected on every render (about 0.3 s for a 20 MB file on one line)                                                                   | Memoize it by the file's identity and the delimiter the person chose                                                                                                                                                               |
| Validation row numbers count records, so a skipped blank line or a line break inside quotes makes them differ from an editor's line numbers (1.9.0 review) | The import dialog also says the file's line of a failing row (the parser keeps it), and the report keeps the records' numbers                                                                                                      |
| A NUL byte in an `expected` value gives the message "A value that finds a row is not valid for the type of its key column" (1.9.0 review)                  | A message that names the right thing                                                                                                                                                                                               |
| PostgreSQL 12 to 16 and 18 run only in CI                                                                                                                  | The release checklist says to run `npm run test:pg-matrix` first (`docs/releasing.md`), and the milestone does                                                                                                                     |

## 10. Security and privacy

| Risk                                                                                  | Control                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The CSP breaks a screen quietly                                                       | The report-only spike and a Playwright test that fails on any `securitypolicyviolation`; enforcing only after both                                                                                                                 |
| A nonce that repeats, or a script without one                                         | Tests: a different nonce on every response, present on every script, absent from no script; the header carries the same nonce                                                                                                      |
| The statistics reveal values                                                          | The columns that hold values are never read (a rule test over every statement of the adapter); what is read is a fraction, a count and a width                                                                                     |
| The plan holds a literal of the person's statement and ends up stored                 | It lives in the tab's memory like a result; the privacy rule test covers `features/sql` including the plan files                                                                                                                   |
| A hostile table name breaks an exported file (Markdown, Mermaid, DBML, PlantUML, SQL) | Per-format quoting, golden and hostile-name tests, the SQL round trip against a real PostgreSQL                                                                                                                                    |
| An `INSERT` script with a value that is read as SQL                                   | Every value a quoted literal with the quote doubled, every identifier quoted from the catalog, `standard_conforming_strings` stated; the round trip with hostile values (quotes, backslashes, semicolons, `--`, unicode, newlines) |
| An `INSERT` script that is cut, or a name that ends its comment                       | A cut script ends in `ROLLBACK;`, so it commits nothing; every name in a comment is flattened (line breaks and control characters), with a hostile-name test                                                                       |
| Chosen rows exported with a key list as an oracle                                     | At most 500 keys; the page reader's rules (hidden columns, data-access gate, per-connection gate) apply unchanged; a key that does not exist gives nothing, as a filter that matches nothing does                                  |
| An **activity and locks view** (not in this release)                                  | Left out on purpose: `pg_stat_activity` shows the text of other sessions' queries, which can hold values. If it is ever built, it shows what runs and waits without the text, and the text only behind data viewing                |

## 11. Milestones

| #      | Work                                                                                                                                                                                                                                                                                                                                                     | Ends with                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **V0** | Housekeeping (section 9) and the patch updates; the whole gate                                                                                                                                                                                                                                                                                           | A commit with no behaviour change except the small fixes                         |
| **V1** | CSP spike in report-only through the whole suite; the list of what must be allowed; the test that fails on a violation; then the enforcing header, nonce tests, its own decision                                                                                                                                                                         | A green suite with the policy enforced                                           |
| **V2** | Plan viewer: `FORMAT JSON` in the runner, the parser, the tree, the marks, the text switch; privacy rule                                                                                                                                                                                                                                                 | Unit tests of the parser (hostile plans), an end-to-end test, axe in both themes |
| **V3** | Statistics: the adapter read, the route, the Table details view, the rule test for the forbidden columns                                                                                                                                                                                                                                                 | Adapter tests on PostgreSQL 17 here and 12 to 18 in CI                           |
| **V4** | Documentation and diagram exports with their golden and hostile-name tests; the dialogs                                                                                                                                                                                                                                                                  | Four formats, four test files, the export dialog                                 |
| **V5** | Export of chosen rows (key list) and the `INSERT` script; the round-trip test                                                                                                                                                                                                                                                                            | The round trip green on 12 to 18, the rules of the export unchanged              |
| **V6** | README, guide, `SECURITY.md` (the CSP line moves from "known limits" to "what protects you"; the statistics and the exports), threat model section 12, decisions, changelog, version **1.10.0**; a lighter independent review (the CSP and the quoting of every exported text), its findings fixed with tests; the whole gate; the PostgreSQL matrix; PR | A PR the owner merges, and publishes themselves                                  |

V1 goes first because it is the only item that can change how every screen loads; V2 to V5 are independent of each other and of V1 and can be done in any order.

## 12. Decisions taken (2026-11-23): every recommendation accepted

1. **Scope of 1.10.0.** _Recommend_ all of section 1. If the release must be smaller, the order of value for the cost is V1, V0, V4, V2, V3, V5.
2. **CSP style policy.** _Recommend_ `style-src 'unsafe-inline'` with a nonce for scripts only; the alternative (no inline styles at all) means replacing every `style` attribute of React Flow and the menus, which is not a change of a release like this one.
3. **Do the statistics need "Allow viewing table data"?** _Recommend_ no (they read no row and no value, like the row-count estimate). Say yes if you would rather a connection that is "structure only" stay structure only: it is one check in the route.
4. **Export of chosen rows by key list**, not in the browser. _Recommend_ the server route (section 8.1), because a value cut by the grid must never end up in a file.
5. **The `INSERT` script format.** _Recommend_ include it, with the round trip in CI, and all values as quoted text literals (no casts). The alternative is to leave it out again.
6. **The Monaco/dompurify advisory.** _Default, not asked:_ an `overrides` entry if a fixed `dompurify` exists, otherwise recorded as accepted with the reason.
7. **A lighter independent review** of the CSP and the quoting of the exported texts, with fresh eyes, before the PR. _Recommend_ yes: the 1.8.0 and 1.9.0 reviews both found real faults.

## 13. Risks of the release itself

- **The CSP is the one change that can break something quietly** in a place no test visits (a dialog that opens a blob, a library that makes a worker). The spike with a violation listener on every screen is there for that, and the policy is enforced only after it is clean.
- **Quoting for five text formats** is a place for a subtle bug. The tests that use hostile names, and the SQL round trip against a real database, are the answer; the review looks at this first.
- **The statistics differ by server version and role** (`pg_stats` columns, a restricted role sees fewer). Tests against 12 to 18, and the screen says why a figure is missing instead of showing zero.
- **Scope creep from "insight".** A plan viewer and statistics invite a query advisor and a health score. Neither is promised: they are opinions the product would then have to defend.
