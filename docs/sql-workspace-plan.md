# SQL Workspace plan (1.6.0)

Status: **S0 to S5 done** (2026-11-19: Monaco works in the packaged app, decision 142; the server runner and its security tests; the SQL tab; several query tabs; completion from the catalog, decision 143). S6 not started. Follows 1.5.2.

A new **SQL** view in the workspace tabs: a Monaco editor with SQL highlighting and autocomplete from the connected database's own catalog, several query tabs, a results grid, and a history of what was run.

This is the biggest change to DataCanvas's promises since writes (1.4.0): until now **no text typed by the person became SQL**. A SQL Workspace is exactly that. Most of this plan is about keeping the rest of the promises true.

## 1. What we promise

1. **Reads only.** A query runs inside a read-only transaction that the server starts, on a connection of its own. `INSERT`, `UPDATE`, `DELETE`, DDL and `SET SESSION ...` fail in the database, whatever `--enable-writes` says. The SQL Workspace is never a way to write (decision 141).
2. **Nothing leaves the machine.** Editor, language support and workers are bundled in the package; no CDN, no font or script from anywhere else. Completion works from the catalog already loaded; no text is sent anywhere.
3. **Queries and results are kept in memory** by default. Query text can hold literals and personal data, so it is treated like row values (decisions 125 and 131). What may be saved is an open question (section 9).
4. **The viewing switch still rules.** Running a query shows rows, so it needs "Table data" switched on for the connection, exactly as the Data tab does.
5. **It cannot hurt the server.** A statement timeout, a row cap, a byte cap, one query at a time per connection, and a Cancel button that really cancels.

Said plainly in the docs: **column masking does not apply to SQL results.** A query can alias or compute any column, so a name-based mask cannot be a control (it already is not one for the Data tab). The Workspace shows what the connected role can read; the role is the control.

## 2. What is not in 1.6.0

- No write statements (a later release could add them through `write-service.ts` with all four switches, an explicit confirmation per statement, and the history rules of decision 131).
- No multi-statement scripts (one statement per run), no `psql` meta-commands, no `COPY`.
- No saved queries on disk, no sharing, no query plan visualiser (`EXPLAIN` text only).
- No result editing: results are read-only. Editing rows stays in the Data tab.

## 3. The server side (milestone S1)

### 3.1 A separate capability

A new interface `SqlRunnerAdapter` in `database-core` (not a method on `DatabaseAdapter`, which keeps "there is deliberately no method that runs arbitrary SQL"), detected by `isSqlRunnerAdapter` like `isWritableAdapter`. Implemented by `PostgresAdapter` and `MockDatabaseAdapter`. Only one file, `apps/web/lib/server/sql-service.ts`, may touch it; an architecture rule says so, in the same style as the write rule.

```ts
runStatement(request: { text: string; maxRows: number; timeoutMs: number; signal: AbortSignal })
  : Promise<{ columns: { name: string; dataType: string }[]; rows: (string | null)[][];
              truncated: boolean; command: string; rowCount: number | null; elapsedMs: number }>
```

All values come back as text (as the Data tab does), cut at the same cell length inside the database where possible, with the same response byte cap (`MAX_RESPONSE_CHARS`).

### 3.2 How a statement runs (the part that must be right)

The scan of the code found four ways a typed statement could escape `BEGIN READ ONLY`; each has an answer and a test (red first):

| Risk                                                                                                                                                                     | Answer                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SELECT 1; COMMIT; DROP TABLE x` in one text (simple query protocol runs all of it)                                                                                      | Run through the **extended protocol** (parameter list given, even empty): PostgreSQL then refuses more than one statement. A test sends exactly this and expects a refusal                                                       |
| A lone `COMMIT` or `ROLLBACK` ends our transaction early                                                                                                                 | Nothing else runs after it on that connection; the connection is closed afterwards in every case, and a test checks that a following statement cannot write                                                                      |
| `COPY (...) TO PROGRAM`, `DO $$ ... $$`, `CALL`: a read-only transaction does not stop them (found in S1)                                                                | The first word must be SELECT, WITH, VALUES, TABLE, EXPLAIN or SHOW, checked in the service and again in the adapter; a role that may run server programs from a function it calls stays a risk, and **the role is the control** |
| `SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE` or `SET default_transaction_read_only = off` leaks into a pooled connection and changes later write transactions | A query runs on a **dedicated connection** opened for it and ended after it, never on the pool. A test runs the `SET`, then checks the next write transaction is unaffected                                                      |
| `BEGIN READ WRITE` inside the transaction                                                                                                                                | The database refuses it inside a read-only transaction; test                                                                                                                                                                     |

Also on that connection: `statement_timeout` (default 30 s, the person may choose up to 5 min), `lock_timeout` 3 s, `idle_in_transaction_session_timeout`, `application_name = 'DataCanvas SQL'`, and `default_transaction_read_only = on` as a second guard besides `BEGIN READ ONLY`. Side effects that a read-only transaction does not stop (`pg_sleep`, `nextval` is refused, `dblink`, advisory locks) are bounded by the timeout; the role warning already tells the person what the role can do.

### 3.3 Limits, gate, cancel

- Rows: 1,000 by default, up to 10,000 by choice; "Showing the first N rows" when cut. A cursor-less cut: fetch N+1 through the driver's row stream and stop, so a huge result never fully crosses the wire.
- A `SqlGate` like `RowsGate`: one query at a time per connection, a second says `sql_busy` plainly (a tab shows "another query is running").
- Cancel: abort the request; the server sends `pg_cancel_backend(pid)` from a second connection (pid known from the dedicated one) and closes it. Test with `pg_sleep(30)`.
- Errors: the database's own message is shown (a SQL tool is useless without it) but passed through the same redaction as other errors for the connection string and password; position is mapped to the editor as a marker.

### 3.4 The route and the rules that change

`POST /api/connections/:id/run` with a strict body `{ text, maxRows, timeoutMs }` and JSON only, no GET, the same guards as every write route (host, origin, token, size limit; the body limit is 256 KB). The route name avoids the words the existing test forbids; that test (`tests/security.test.ts`, "no arbitrary SQL, ever") is **amended to allow exactly one route** and to fail if a second one appears, rather than loosened.

Rule changes, all in the same commit as the code, not after:

- `security.test.ts`: the "no route accepts SQL" test becomes "exactly one route accepts SQL, it is `run`, it needs `dataAccess`, and it uses `SqlRunnerAdapter` through `sql-service.ts` only".
- `architecture.test.ts`: only `sql-service.ts` imports `SqlRunnerAdapter`; `database-core` still has no dependencies; `WritableAdapter` still takes no text.
- `features/sql/*` and `sql-store.ts` fall under the same "no browser storage, no console" privacy test as `features/writes` (extended if section 9 allows saving drafts).
- Document-truth tests: README, SECURITY.md, the threat model and the guide stop saying "no SQL"; they say "no SQL by default; the SQL view runs read-only statements you type".
- Docs to rewrite: `threat-model.md` (new attacker row: "text typed into the SQL view"), `decisions.md` (116, 127 and the lines that say reads never take text), `data-viewer-plan.md`, `development-plan.md`.

## 4. The editor (milestones S0, S2, S4)

**Spike first (S0, half a day).** Monaco with the Next 16 / Turbopack build is the least proven part: the usual worker guidance targets webpack. The spike answers three questions before anything else is built, and the plan is changed if the answer is no:

1. Does `monaco-editor/esm/vs/editor/editor.api` + the `pgsql` basic language + the base editor worker bundle and run offline inside `npm run package`?
2. How big is it (measured: +5 MB in `.package`, loaded **only** when the SQL view opens, never in the first page; decision 142)?
3. Do workers load under the headers the app sets (`COOP/CORP same-origin`; no CSP beyond `frame-ancestors`)?

Fallback if Turbopack cannot bundle the workers: copy Monaco's prebuilt `min/vs` into a `public/monaco` folder in the package build and load it with `loader.config({ paths: { vs: "/monaco/vs" } })`. Fallback of last resort, to be decided with the person: CodeMirror 6 (about a tenth of the size, no workers). `@monaco-editor/react` is used only with `loader.config({ monaco })` pointing at the local package, never its default CDN loader (a rule test greps for the CDN host).

**Look and behaviour.** Theme follows the app's light and dark; font and 32 px control rules from the UI polish plan apply to the toolbar. Run with Ctrl or Cmd plus Enter, run the selection if there is one, Cancel replaces Run while running. Keyboard: Monaco traps Tab, so Escape then Tab leaves the editor (documented in the view, and tested). Screen-reader mode is on when the OS asks for it. On a phone the editor stacks above the results and is usable but not optimised; the plan says so rather than pretending.

**Autocomplete (S4)** comes from data the app already has, via the existing routes (`structure`, `objects`): schema names, tables and views, columns with types (after `table.` or an alias, resolved by a small tokenizer, not a full parser), function names with arguments, and Monaco's own keywords and built-ins from the `pgsql` language. Loaded once per connection into memory, refreshed after a structure change. Case-insensitive, quoted identifiers where needed. No snippets beyond a few (`SELECT ... FROM`, `JOIN ... ON`). Nothing about completion touches the server beyond those catalog reads.

## 5. Tabs, results, history (milestones S2, S3, S5)

**Query tabs.** Several tabs per connection: new, rename, duplicate, close, reorder, a dot when a tab has unsaved running work. Each holds its text, selection, last result and run state. Closing the last tab leaves one empty tab. State in a `sql-store` (Zustand, plain `create`, memory only), keyed by connection id and dropped with the connection like the writes store.

**Results grid.** Extract the presentational part of `features/data/data-grid.tsx` (table, keyboard navigation, cell dialog for long values, NULL versus empty, blur-for-screenshare) from its sort, reveal and edit logic, and reuse it for result sets. A result has columns without a table, so `RowPage.order`, sorting and masking do not apply; the extracted grid takes columns and rows only. Column type names come from the result's type ids (looked up with `format_type`). Under the grid: command tag and row count, elapsed time, "first N rows" notice. Copy as TSV, CSV or JSON; **Export CSV** from what is on screen (the browser makes the file; the server never writes one). Long cells open in the existing cell dialog.

**Query history.** Per connection, memory only, newest first, capped at 200: the text, time, duration, rows, and outcome (the database's error code for a failure, not its message). Click to open in a new tab, re-run, search, clear. It lives only in the browser's memory: nothing about it goes to the server, so there is nothing for the server to forget.

## 6. Milestones

Each milestone is red-first, ends with all checks green, and is a separate commit on one branch.

|     | Milestone                      | Done when                                                                                                                                                                                                                        |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0  | Monaco spike (section 4)       | **Done.** Bundles under Turbopack and runs offline; +5 MB in the package, 3.5 MB (0.9 MB compressed) loaded when the view opens; workers start under the current headers. Decision 142, with the tested import list              |
| S1  | Server runner and its security | `SqlRunnerAdapter` (Postgres and mock), `sql-service`, `run` route, gate, cancel, limits; the four escape tests above pass against a real Postgres; rules and docs changed in the same commit                                    |
| S2  | SQL view with one tab          | New "SQL" tab in `workspace.tsx` (`WorkspaceView` gains `"sql"`), editor, Run/Cancel, extracted result grid, error markers, needs-data-access state; e2e: run a query, see rows, cancel `pg_sleep`, a write statement is refused |
| S3  | Multiple tabs                  | Open, rename, duplicate, close, switch without losing text or results; e2e                                                                                                                                                       |
| S4  | Autocomplete                   | Catalog-based completion incl. alias columns; unit tests for the tokenizer; e2e picks a column suggestion                                                                                                                        |
| S5  | History and export             | History list, re-run, copy and CSV export, EXPLAIN button; privacy test covers `features/sql`                                                                                                                                    |
| S6  | Polish, docs, release          | Dark theme, phone layout, axe-core on the view, size and speed measured (open time, 10,000 rows), README and guide chapter, threat model, CHANGELOG, version 1.6.0, PR                                                           |

Rough size: S0 0.5 day, S1 2 days (the careful one), S2 2 days, S3 1 day, S4 1.5 days, S5 1 day, S6 1.5 days.

## 7. Testing

- **Unit:** the tokenizer for autocomplete, history list, tab store, CSV/TSV/JSON writers (quotes, newlines, formulas: a cell starting with `=`, `+`, `-` or `@` is prefixed with `'` in CSV so a spreadsheet does not run it).
- **Integration (real Postgres, all of 12 to 18 in CI):** the escape tests of section 3.2, timeouts, row cap, cancel, error redaction, a query as a role that cannot read a table.
- **Security tests:** the amended rules of section 3.4; a rule that nothing in `features/sql` calls `fetch` except through `api.ts`; no CDN host anywhere in the bundle.
- **e2e (packaged app):** the S2 to S5 flows, a phone viewport, axe on the view, screenshots for the README.
- **Performance:** opening the SQL view stays under a set budget (decided after S0); 10,000 rows scroll without jank.

## 8. Risks

| Risk                                            | Plan                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Monaco does not bundle under Turbopack          | S0 first; fallbacks above                                                                                                     |
| Package grows too much                          | Lazy-load; a size check in `verify-package.mjs` (warn above a number chosen after S0)                                         |
| A typed statement writes or changes the session | Section 3.2 and its tests; this is the review focus before release, with a second reviewer reading only the runner like 1.5.2 |
| A long query holds a connection                 | Dedicated connection, gate, timeout, cancel                                                                                   |
| People expect masking to hold in SQL results    | Said at the top of the view and in the docs; masking was never a control                                                      |
| Query text saved somewhere it should not be     | Memory only unless section 9 says otherwise, with a privacy test either way                                                   |

## 9. Open questions for the person

1. **Keep the text of tabs across a reload?** The default here is no (memory only), which means a page refresh loses unsaved queries. The options are: (a) memory only, with "Save as .sql file" and "Open .sql file" on each tab; (b) also keep tab text in this browser's `localStorage` (not results, never history), cleared by a "Forget my queries" button; (c) keep tabs in a file on disk next to the saved workspaces. **Recommendation: (a) for 1.6.0**, and (b) as an opt-in switch afterwards, because query text is typed data and it is better to add saving later than to remove it.
2. **Default row cap**: 1,000 with a 10,000 maximum, or lower?
3. **Should `EXPLAIN ANALYZE` be offered?** It runs the statement (still read-only). Recommendation: yes, labelled "runs the query".
