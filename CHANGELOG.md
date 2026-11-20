# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project intends to follow [Semantic Versioning](https://semver.org/) from 1.0.0.

## [Unreleased]

## [1.7.1] - 2026-11-20

### Added

- **Unlogged tables and storage options in migrations.** A migration now creates a table `UNLOGGED` and with its `WITH (fillfactor=...)` options, switches a table between logged and unlogged (`SET LOGGED` or `SET UNLOGGED`, which rewrites the table), and sets, changes and resets storage options. Partitioning, inheritance and tablespaces are still not carried, and a warning names each table that has them.
- **A button in the SQL tab that reads the table and column names again** for completion, for a change made by another tool after the tab opened.

### Fixed

- **A step held back (a destructive step you have not confirmed) now holds what follows it.** A view that is dropped to be made again, a function dropped and created, or a step that depends on the held one, used to run while the drop stayed commented out, and failed. They are now written commented out with the reason ("it follows s3, which is not confirmed"). Confirm the destructive step and both run.
- The options of a table are compared as a set: the catalog keeps them in the order they were set, so the same options in another order no longer look like a difference.

### Tests and internals

- **A property check for the migration planner**: random small databases and random changes (tables, columns, types, defaults, constraints, indexes, foreign keys, views, comments), each planned and run on a real PostgreSQL, up and then down, with the seed and both databases printed on a failure. 400 pairs pass; the default run is 40 (`DATACANVAS_PROPERTY_RUNS`, `DATACANVAS_PROPERTY_SEED`).
- The two row grids (the Data section and the SQL result) share one keyboard-navigation hook instead of two copies.

## [1.7.0] - 2026-11-19

### Added

- **A Migrations tab: write the SQL that makes one database look like another, with its rollback.** Choose _From_ and _To_ (a snapshot, or the live database of any connection: staging against production works) or press **Generate a migration from this comparison** in Snapshots. Tables, columns, constraints, indexes, foreign keys, schemas, extensions, types, sequences, functions, views, triggers and row-level-security policies are covered, in an order that runs (what depends on something is dropped first and made last; nothing uses `CASCADE`). DataCanvas writes the text and **runs none of it**. Decisions 147, 148, 150.
- **Every step says what it risks**: a lock, a table rewrite, it can fail on existing rows, it destroys data, it cannot be undone. A summary shows the counts and how much of the migration a rollback can undo. You can leave a step out (what needs it goes with it) and **confirm each destructive step**: until then it is written commented out.
- **Possible renames** are suggested with the reason (a table that is gone and one that is new with the same columns, a column of the same type in the same place, a sequence with the same settings and owner), and nothing is renamed until you confirm it: a rename keeps the rows, a drop and an add does not. Decision 149.
- **Export** as plain SQL (for `psql`), one file for **dbmate** or **goose**, a **Flyway** pair (`V` and `U`), or `up.sql` and `down.sql`. A step that cannot be in a transaction (`CREATE INDEX CONCURRENTLY`, a new enum label) is written outside it, in its place. Every file starts with what it compares, the verdict of the rollback, what was not compared, and a reminder to read it. Decision 151.
- Options: create indexes without blocking writes, and add checks and foreign keys unvalidated, then validate.
- Snapshots (format 3) now also record what a migration needs: identity, generated columns and collations, deferrable and not-yet-validated constraints, partitioning, inheritance, unlogged tables, storage options, and more comments. Older files still open, and a migration says which parts a file could not give it. Decision 146.

### Security

The generator was read from the code by a second reviewer before this release (docs/threat-model.md, section 9b). It reproduced four high findings, all fixed:

- A sequence named with a line break could put a statement on its own line in a step that was only a comment, and run it once the step was confirmed. Names in comments are now cut to one line.
- A name that was exactly a dbmate or goose marker moved the boundary between the up and the down part. The text is now checked, before the markers are added, for any line a runner could read as a command, and the format is refused if there is one.
- A collation with a dot in its name (`C.utf8`) could not be planned; its schema and name are now kept apart.
- Renaming a column that owns a sequence planned a new sequence that restarted at 1; the sequence now follows the column and is offered as a rename.

Six medium and five low findings (steps that did not record what they wait for, a type change with a default that cannot be cast, risks that were missed, a policy on a retyped column, and others) are fixed too. One is accepted and written down: an unconfirmed destructive step does not hold the steps that depend on it, which then fail loudly.

### Changed

- The first statement in a rollback of a changed numeric, floating-point or time-zone column is now marked as one that loses data.

## [1.6.0] - 2026-11-19

### Added

- **A SQL tab: type a statement and run it, read-only.** It needs _Allow viewing table data_ for the connection. One statement at a time runs in a read-only transaction on a connection of its own, with limits on rows (1,000 by default, 10,000 at most), bytes and time, and a Cancel that cancels it in the database. It cannot write, even with `--enable-writes`. Decision 141.
- **An editor** (Monaco, built into the package, nothing fetched from another host) with SQL highlighting, in the app's colours in light and dark, and **completion from your database's own names**: tables, views, schemas and CTEs after `FROM` and `JOIN`, the columns in scope (with their types), `alias.` and `schema.table.` columns, functions, keywords and two snippets. Nothing is sent anywhere for completion. Decisions 142 and 143.
- **Query tabs**, each with its own text, undo history and result: new, rename, duplicate, close (the mouse, the toolbar or Delete), arrow keys between them, **Save as .sql** and **Open .sql**. Queries are kept only until the page is closed.
- **A results grid** that tells NULL from the empty string, opens long values in a dialog, and says when rows were left unread. **Export** copies the rows as TSV, CSV or JSON or saves a CSV file; a value a spreadsheet would run as a formula gets a leading apostrophe.
- **Explain** and **Explain analyze** (which runs the statement) on a query, the plan shown as text; the database's errors with their code, the line and column, and a mark in the text.
- **Query history** per connection (in memory, 200 entries at most): search, open in a new tab, run again, copy, clear.
- A note above the editor when the role is a superuser or may run programs or read files on the database server, because a function can reach those from a `SELECT`.

### Security

The SQL runner was read from the code by a second reviewer before this release (docs/threat-model.md, section 8b). It found two ways past the checks, both fixed:

- A carriage return made the first-word check and PostgreSQL disagree about where a comment ends, so a `COPY ... TO PROGRAM` or a `DO` could follow an allowed word. White space is now read as PostgreSQL reads it and any other control character is refused (decision 144).
- PostgreSQL runs `EXPLAIN ANALYZE CREATE TABLE ... AS`, `CREATE MATERIALIZED VIEW` and `SELECT ... INTO` without its read-only check. `EXPLAIN` is now allowed only for a plain query without the word `INTO`.
- A result is read in small batches and stopped at 64 MB; a cancel is repeated until the statement ends, and an abort while connecting ends the wait at once.
- Accepted and written down: one single huge value is still read whole, and what a privileged role's function can do outside the database is for the role to limit.

### Changed

- The package is about 5 MB larger (the editor), loaded only when the SQL tab opens.
- Documents that said DataCanvas has no way to run your SQL now say where it can (the SQL tab, read-only).

## [1.5.2] - 2026-11-18

### Added

- **Export migration (.sql).** The session history can now download the changes of structure made in the session (new tables, added columns, renames, drops) as one SQL script in a transaction, in the order they ran, ready to run on another database. Row changes are left out and counted in a comment (decision 138). The session keeps the latest 500 structure changes; if older ones were dropped, the script says so at the top.

### Security

The write path was reviewed from the code by a second reviewer. No way to run SQL of its own or to apply something other than what was previewed was found, and the only way found to reach writes without the token was a development server (below). Fixed from the review:

- A type change that rounds or cuts values (numeric to integer, timestamp to date, or fewer decimals) is now marked destructive with a "lossy" warning.
- A preview is now refused at apply if the type, length or precision of a column it names changed in the meantime.
- Deleting a row now names the tables reached through a chain of `ON DELETE CASCADE` keys, to its end, not only those that point at the row directly.
- Writes now need a session token as well as `--enable-writes`, so a development server never has them on.
- Accepted and written down in `docs/threat-model.md`: the session cookie is shared across ports, unlock is friction rather than authentication, and previews are bounded only by count and time.

## [1.5.1] - 2026-11-18

### Fixed

- **A long value no longer breaks the edit form.** A value with no spaces, such as a 64-character hash, stretched the dialog sideways, so Cancel and Preview were only reachable by scrolling to the right. Sized dialogs (the forms and builders) never scroll sideways now.

### Changed

- A long text value (over 48 characters, or with line breaks) now starts as one short line in the row forms. An **eye button** beside it shows the whole value (for a value that was read in full), wrapped and editable, and a second press folds it back.

## [1.5.0] - 2026-11-18

### Added

- **DataCanvas works on a phone.** Below 768 px the sidebar is a drawer opened by a menu button in the header; picking a table or a connection closes it. The view tabs and the Data toolbar scroll sideways, and every form dialog is a full-screen sheet under 640 px.
- A **"Changed" marker and a Reset button** on each field of the row editor, a footer that says how many columns changed (or why Preview is waiting), and **Ctrl or Cmd plus Enter** to preview from any field. Focus starts on the first editable column that is not the key.
- Tooltips on the icon buttons of the sidebar and the row actions.

### Changed

- **The forms that change data were redone on shared pieces**: three dialog sizes (448, 640 and 768 px), one type scale (nothing under 12 px in a dialog), one spacing rhythm, and a footer that stays in view while the body scrolls. Values use a control that fits them (a switch for a boolean, a one-line field for a number or a date, a field that grows for long text); NULL and Default are small toggle buttons beside the field instead of radios. The add-row dialog no longer changes height as you work.
- **The table builder** puts each column and foreign key on one grid with a header; "Array" and "Can be NULL" are toggle buttons; the heading shows the column count.
- **The sidebar's writes bar** is one line (badge, lock, changes); the read-mode role note takes two lines and expands. The Data toolbar is grouped into paging, actions and view, and the row actions are 32 px targets. The unlock dialog says each thing once.
- Muted text in light theme is darker, to reach the 4.5:1 contrast minimum.

## [1.4.0] - 2026-11-16

### Added

- **Editing rows and designing tables**, off unless DataCanvas is started with the new **`--enable-writes`** flag, and only for a database on this machine (`localhost`, `127.0.0.0/8` or `::1`). Unlock writes for a connection by typing its database name (viewing table data must be on); the unlock is kept in memory only and ends on disconnect, reconnect or restart, and a red **Writes on** badge shows while it lasts. Then:
  - in the Data section, **edit** a row's values, **add** a row (each column a value, NULL or its default) and **delete** a row, on tables with a primary key, or a unique index that is not partial, over plain columns that cannot be NULL;
  - **create a table** from a form (types from a fixed list, structured defaults, identity columns, primary key, unique constraints, foreign keys to existing tables, comments);
  - **alter a table**: add, rename and drop columns, rename and drop the table, change a column's type where PostgreSQL can convert it on its own, set or drop NOT NULL and defaults, add primary keys, unique constraints and foreign keys, drop constraints, create and drop indexes.
- Every change is **previewed** as the exact statement that will run, with what to know first (triggers, foreign keys from other tables and their actions, row-level security, locks and table rewrites), and **applied** exactly as previewed, in one transaction, with a 3 second lock timeout. A preview can be applied once, within five minutes. A row change must change exactly one row, and an update is refused if a column being changed no longer holds the value that was seen (other columns are not compared, and a delete compares no values). Drops need the table name typed and are refused while anything depends on them; nothing uses `CASCADE`. Database errors become fixed sentences that never contain a value.
- A preview can only be applied to the table it was made for: if the table was dropped and recreated, or a column it names was dropped, re-added or replaced (its identity changed), in the meantime, applying is refused (a changed type, default or NULL setting does not count) and the person previews again. Dropping a column is refused while a generated column is computed from it.
- A **role check**: a warning when the database user can do more than needed (when browsing: change data or create objects; with writes unlocked: superuser, create roles or databases, bypass row-level security, reach the server's files).
- A **session list of changes**: kind, table, column names, time and outcome (and the statement for a change of structure, left out when it carries a default value or a comment you typed), in memory only, never row values.
- New routes under `/api/connections/:id/writes/` (`unlock`, `lock`, `edit-info`, `preview`, `apply`, `history`, and the status at the root) and `GET /api/connections/:id/role`. Every request is a strict structured operation; there is no field for SQL, a WHERE clause or an expression.
- **Find a table** in the sidebar: a search box at the top of the schema list narrows it to the tables and views whose name contains the text, in every schema (including those not yet opened), with the matching part marked and a count of the matches. Clicking a result does what clicking a table in the list does. **Escape** or the clear button brings the list back as it was. The text is matched in the browser and never sent anywhere.

### Changed

- **The documents** say what changed in the promises: DataCanvas is read-only **by default** and never changes a database unless started with `--enable-writes`, on a local database, with the connection unlocked (README, `SECURITY.md`, `docs/threat-model.md` with a new section on writes, `docs/getting-started.md` with a new section, the CLI help). The design and its decisions are in `docs/data-editing-plan.md` and decisions 124 to 136.

## [1.3.0] - 2026-11-16

### Added

- **Sorting** in the Data section. Click a column header to sort by it: ascending, then descending, then back to the key order. NULL comes last when ascending and first when descending (the database's own order, so a plain index can serve it), and rows that tie are ordered by the table's key, so paging through a sorted table shows every row exactly once. The note under the grid says how the page is ordered. A column that cannot be sorted has no button and a tooltip that says why: it is hidden (show it first), the table has no primary key or unique index to break ties, or its type has no useful order (`json`, `jsonb`, arrays, `bytea` and similar).
- **Filtering**, from a **Filter** button above the grid. Choose a column, a condition and a value; up to three conditions can be in force, all of which must match, shown as removable chips with **Clear all**. Conditions: equals, does not equal, is greater than, is at least, is less than, is at most, contains, starts with, is NULL and is not NULL, offered by the kind of column (text columns have them all; numbers, dates, booleans and enums have the comparisons; every column has the two NULL tests; `json` and arrays have only those). Values are compared as the column's type (9 comes before 10; an enum in its declared order); a value that does not fit says so in plain words and the filter can be removed. **contains** and **starts with** ignore case and take the value literally (`%` and `_` are ordinary characters; there are no patterns). **does not equal** also matches NULL. Filtering works on tables without a key. While a filter is on, the page says "filtered" instead of the size estimate. A hidden column can be sorted or filtered once you reveal it; hiding it again removes its sort and filters.
- A read with a sort or a filter is **stopped after 5 seconds** (a plain page keeps the usual limit) with a plain sentence and an offer to remove the filters or the sort; the API answers `422` with the code `too_slow`.
- `POST /api/connections/:id/rows` takes two optional keys, `sort` (`{ column, direction }`) and `filters` (up to three `{ column, op, value? }`). The request, the sort and every condition are strict objects, the operator is a fixed list, and a value is at most 200 characters. The page answers with the `sort` and `filters` that were applied, whether the sort value was too long to page past (`sortValueTooLong`), and each column's `kind`.
- Rules that fail the build: the request is strict at every level; the service builds no text from a sort or a condition; the statement code never uses `LIKE`, `ILIKE`, `SIMILAR TO` or a regular-expression operator, and passes every value as a parameter; no sort or condition type appears in a saved file or a store. A generated test of 400 hostile requests checks the statement's grammar.

### Changed

- **The documents** describe sorting and filtering: `docs/getting-started.md`, `docs/threat-model.md` (new rows for reading a hidden column through a condition, injection through a sort or condition, the load of a heavy read, and the value of a condition) and `SECURITY.md` (what a sort or condition can and cannot do, and its limits). A sort or a condition on a hidden column is refused until the column is revealed, because it would read it back one comparison at a time.
- The rows response has new fields (`sort`, `filters`, `sortValueTooLong` and a `kind` on each column). Nothing else about the API or the saved files changed.

### Fixed

- With a long list of tables (a database with many tables, such as a CMS schema), the page itself could scroll, which slid the app up and left a blank area under the canvas, and the table data below it looked missing. The page frame is now exactly one screen tall and never scrolls; the table list and the rows grid scroll inside it, as intended. The cause was the screen-reader-only labels in each row (an absolutely positioned element with no positioned ancestor escaped the scroll areas and stretched the whole page).

## [1.2.0] - 2026-11-16

### Added

- **Viewing table data**, optional and **off by default**. Switch on **Allow viewing table data** for a connection (in the connect dialog, with the switch beside the connection in the left list, or in a table's new **Data** section) and DataCanvas shows the rows of the tables you open: read-only, one page at a time, never saved, logged, cached, or put in a snapshot, workspace or error message. A badge shows when it is on, and a saved connection remembers the choice.
- The **Data** section: 50 rows per page by default (25, 50, 100 or 200) with Previous and Next, in primary-key order (or the order of a safe unique index; a table without a key, and a materialized view, have no guaranteed order and can be paged only through their first 10,000 rows). NULL is told apart from the empty string; a value over 200 characters opens in a dialog (up to its first 2,000 characters, with a copy button); wide tables show their first 100 columns. A real table with a caption, a sticky header and keyboard navigation (arrow keys, Home, End, Page Up, Page Down, Enter).
- **Hidden columns**: a column whose name looks sensitive (`password`, `token`, `secret`, `api_key`, `salt` and similar) is not read at all until you press its **Show** button, so its value never reaches the browser by default. This is a convenience, not a security control: names are only a hint.
- A **Blur values** switch that blurs the values in the grid and the value dialog, for screen sharing. It is held in memory only and changes nothing about what is read.
- A note when **row-level security** applies to the connected database user and so may hide rows. It does not show for a superuser, a role that bypasses it, or the table's owner (unless the table forces it).
- Every read has limits: rows, columns, characters per cell, about 2 MB per response, the 15 second statement timeout, and one read at a time per connection (three more wait, then the server answers `429`). Foreign tables are not read. Values are converted to text and cut inside the database, so a huge value never travels.
- `POST /api/connections/:id/rows` and `PUT /api/connections/:id/data-access`. The connection summary and saved connections have a `dataAccess` field.
- Rules that fail the build: rows are read only behind the data-access check and are never logged; in the browser they live in component state only (nothing in `localStorage`, `sessionStorage`, `indexedDB`, cookies or caches); a snapshot or a structure read never calls the row reader; and the README, SECURITY.md and the guide never go back to saying that rows are never read.

### Changed

- **The documents.** By default only metadata is read, as before; with data viewing on, rows are read too. `README.md`, `SECURITY.md`, `docs/threat-model.md` (a new asset, "table contents", and the ways rows could leak), `docs/getting-started.md` (a "Look at the rows" section) and the connect dialog say so. Statements about one tab (Overview, Health, Objects, Snapshots) now read "this tab reads no table rows" so they cannot be mistaken for a claim about the whole product. A snapshot never contains rows, whether or not data viewing is on.
- **Saved connections file, format 2.** It adds `dataAccess` to every saved connection; files from earlier releases open as before, with data viewing off. A file saved by this release is refused by an earlier one, which asks you to update.

### Fixed

- A connection saved with "Save this connection" now appears in **Saved connections** right away. Before, it appeared only after reloading the page.

## [1.1.0] - 2026-11-14

### Changed

- Building from source now needs Node.js `^20.19.0 || >=22.12.0` (20.19 or newer on the 20 line, or 22.12 or newer; not Node 21), because the CSS build tool loads an ES-module-only dependency with `require()`. The published package still runs on Node.js 20.9 or newer.

### Added

- **Snapshots** tab: save a database's structure (schemas, tables, columns, constraints, indexes, foreign keys) and compare it later with the live database, with another snapshot, or with a different database. The comparison lists added, removed and changed tables, columns, constraints, indexes and foreign keys, each change with its before and after values, and can be copied as a Markdown report for a review or a ticket. Snapshots can be exported and imported as `.snapshot.json` files. A snapshot holds structure only: no table rows, no row estimates, no credentials. Items are matched by name, so a rename shows as one removal and one addition.
- **Objects** tab: views (with their query, what each reads and which views read it), enums, domains, composite and range types, sequences (and the column that owns each), functions and procedures (with their definitions, language, volatility and security), triggers, extensions, and row-level-security policies grouped per table, with a warning for security that is on without any policy and for policies on a table where security is off. Only definitions and settings are read, never table rows or sequence values. Objects that belong to an extension are left out.
- Snapshots now record these objects and the comparison shows what changed in them (a changed view query or function body is shown before and after). Snapshot file format 2; files from the previous release open as before and their objects show as "not recorded" instead of being reported as new.
- Three new **Health** checks. **Unused indexes**, from the server's usage counters (never a primary key, unique or constraint index; a warning only for a large index (10 MB or more) on a primary, with counters at least a week old or of unknown age, and information otherwise; it says when the index is the only one serving a foreign key, and that a standby's counters only reflect its own queries). **Foreign keys whose column types differ** (integer against bigint is a warning, a length difference only information; domains and enums are not judged). **Naming**: names that need quoting, and foreign key columns not ending in `_id`, each judged against the database's own style and only when at least 80% of it is consistent.
- `GET /api/connections/:id/index-usage`.
- `GET /api/connections/:id/objects`.
- `GET /api/connections/:id/structure`, `POST /api/connections/:id/snapshots`, and `GET/DELETE /api/snapshots[/:id]`, `GET /api/snapshots/:id/export`, `POST /api/snapshots/import`.

## [1.0.2] - 2026-11-13

### Fixed

- Connection strings that put the host in the query, the way libpq and Google Cloud SQL write them (`postgresql://user:password@/database?host=...`), were rejected with a misleading "URL-encoding" message. `?host=` and `?port=` are now understood. A host that is a Unix socket path (`/cloudsql/...`) is refused with an explanation of what to do instead (the instance's host name or IP, or the Cloud SQL Auth Proxy), and a string with no host at all now says so. A host or port given twice that disagrees is an error instead of a silent pick.

### Added

- A "Cloud databases" section in the getting-started guide.

## [1.0.1] - 2026-11-13

### Added

- Dark mode. A sun/moon button in the header chooses Light, Dark or System (follows the operating system and changes with it). The choice is remembered in the browser only, and is applied before the first paint so dark-mode users see no white flash. The canvas (grid, controls, minimap) follows the theme, and images exported in dark mode have a dark background.

## [1.0.0] - 2026-11-13

First stable release. (`1.0.0-rc.1`, published earlier under the `next` tag, was the release candidate.)

### Added

- One-command start: `npx --yes @shubhamtiwari909/datacanvas` (Node.js 20.9+, no native modules, no install scripts).
- PostgreSQL connections by connection string or fields; passwords kept in memory only; clear error codes for authentication, TLS, reachability and timeouts.
- Schema explorer: schemas, tables, views, materialized views, columns, keys, indexes, constraints, partitions, row-count estimates.
- Relationship detection with cardinality, including cross-schema relationships.
- Interactive canvas: drag, zoom, minimap, grid, multi-select, search (on the canvas and in the database), filters, focus mode, inspector panel.
- Foreign tables (for example `postgres_fdw`) are listed, labelled and drawn like tables; they were hidden before.
- Schema overview tab: per-schema counts, cross-schema connections, most connected tables, largest tables and tables without relationships.
- Paths tab: shortest chains of foreign keys between two tables, with the join SQL to copy.
- Health tab: model checks (no primary key, foreign key without index, duplicate and redundant indexes, nullable foreign keys, wide tables) with explanations and copyable SQL.
- Adding a whole schema to the canvas now allows up to 1000 tables (was 200).
- Automatic layouts (hierarchical, grouped, compact, grid).
- Saved connections and workspaces (versioned files, migrations, import and export).
- PNG and SVG export with a privacy notice.
- Local-server protection: loopback only, Host and Origin checks, per-run session token, security headers, no CORS.
- `SECURITY.md` and a threat model.
- Single running instance reuse, graceful shutdown, first-run welcome.
- Test suite: unit, integration (real PostgreSQL), architecture and security rules, Playwright browser tests, packed-tarball verification.

### Known limits

- Verified on macOS only; Windows and Linux are covered by CI that has not run yet.
- No independent security review; no full Content-Security-Policy.
- PostgreSQL only.
