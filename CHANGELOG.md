# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project intends to follow [Semantic Versioning](https://semver.org/) from 1.0.0.

## [1.12.0] - 2026-11-27

The write side, second part: what 1.9.0 deliberately left out. Everything here needs the same three things as any change (`--enable-writes`, a database on your own machine, the unlock) and goes through the same preview and apply. **None of it is available to Claude (the MCP server) or to the command line.** Plan: `docs/write-side-v2-plan.md`; decisions 171 to 175.

**Upgrading:** nothing to do. The only change to what is already there is that `getCell` (the read behind the JSON editor) now also reads `text`, `varchar` and `citext` columns.

### Added

- **Import modes.** The import dialog asks what should happen to rows already in the table. **Add new rows only** is the import as before. **Update existing rows, add the others** (`upsert_rows`) finds a row by a key you choose from the table's own primary key and unique constraints (not partial, not deferrable, every column NOT NULL, every key column mapped), updates the columns you tick and adds the rest; **Leave existing rows as they are** adds only what is new. **Update existing rows only** (`update_by_key`) changes the rows a key finds and adds nothing: file rows that match no row are left out and counted. A file that repeats a key is refused. The preview counts how many rows exist; an overwrite needs the tick that a delete needs. Decision 171.
- **Leave out the failing rows.** After a validation that finds failing rows (up to 1,000, with a 60 second limit of its own and a Cancel), the browser leaves them out, checks the rest again (up to five rounds) and imports what remains, still all or nothing. **Download rejects file** writes the left-out rows as a CSV made in your browser (UTF-8 with a byte order mark, the file's own header and delimiter, and a last column `datacanvas_reject_v1` that names the rule each row broke, never a value), with a reversible formula rule so importing it again restores the values after you accept the dialog's offer.
- **Encodings menu**: a file that is not UTF-8 can be read as UTF-16 (needs its byte order mark) or Windows-1252 / Latin-1 (it accepts every byte, so the dialog warns when the text looks misread).
- **Change every row a filter matches.** With a filter on screen (an empty filter is refused), the selection toolbar offers **Set a value on all matching rows** and **Delete all matching rows** (`update_matching`, `delete_matching`): up to 100,000 rows and 8 million characters of key text. The preview finds the keys with the filter, holds them (one such plan per connection) and shows only the count; you **type the count** and tick the destructive confirmation to apply. The write is the keyed batches of 500 in one transaction, each checked to touch exactly the rows it carries, and a short batch rolls everything back. The filter never becomes the condition of a statement that writes, and the values are not compared (the rows are changed even if they changed since the preview, and the preview says so). Decision 172.
- **Edit cells in the grid.** Double-click a cell (or press Enter) of a table that can be edited, type a value, and review all the pending changes together before anything is written (`edit_cells`): up to 500 rows, 50 cells a row and 2,500 cells in all, one `UPDATE` per row that must change exactly one row. A row whose edited cells changed since you loaded it is left out and counted. It has no tick. Key, hidden, generated and `bytea` columns are not edited this way. Decision 173.
- **Edit a text value the grid cut short.** The dialog of a `text`, `varchar` or `citext` cell reads the whole value from the database and offers **Edit this value** up to 100,000 characters; a value of up to 1,000,000 characters can be read and copied; a longer one is not read. Decision 174.
- Documentation for it: README, the guide, SECURITY.md, the threat model (section 14), decisions 171 to 175 and the plan's measured numbers (PostgreSQL 17.12): an upsert of 100,000 rows in 0.92 s, a change of 100,000 keys by filter about 0.2 s to preview and 0.5 s to apply, finding 1,000 spread-out failing rows 20 to 29 s.

### Changed

- `getCell` reads `text`, `varchar` and `citext` columns whole, with their length and whether they can be edited. The JSON editor itself still opens only for `json` and `jsonb`.
- The write source rule that refused the word `USING` is narrowed to the one keyed delete statement (decision 172).
- Version 1.12.0.

### Not built

- A progress bar for an import (decision 175): it would change the shape of the route that carries every write, for a bar. An import shows a spinner and **Cancel and roll back** as before.
- Paste from a spreadsheet into the grid.

### Known limits

- The tick of a destructive change is enforced by the browser's dialog, not by the server (the typed count of a change by filter is checked by the server).
- Only PostgreSQL 17 has run the new tests so far; the run on 12 to 16 and 18 is still to do.
- A preview of an edit of many different cells is slow (25,000 cells took 25 seconds, which is why a change is capped at 2,500 cells).

### Security

The write side of this release was read by an independent reviewer (a separate agent with fresh eyes, 2026-11-27; see `docs/threat-model.md`, section 14b). It found no way to turn a value, a filter, a key or a column name into SQL, no value in an error, a preview, the history or a skipped list, and no exposure of the new writes through the MCP server or the CLI. It reproduced five problems, none of them a way to write what was not asked for; all are fixed, each with a test that failed before the fix:

- **A key whose name looks sensitive could be guessed through an import by key.** The preview of an update or an update-or-insert said whether a key existed. Such a key is now refused for these imports, and the dialog does not offer it.
- **The editor of a cut text value changed Windows line endings.** A value with `\r` is now shown read-only, with the reason.
- **Keys equal only under a case-insensitive collation were not seen as repeated.** The check now uses the column's own collation.
- **Deleting by filter in a table that cascades onto itself failed with a misleading message.** More than one batch is refused at preview with a clear sentence; one batch runs, with a warning.
- **A table with child tables (inheritance) was accepted for changes by key and then failed.** It is now refused with a clear sentence.

Also: the browser now checks that the edits it holds fit in one request (32 MB) before the preview.

Known and accepted: the typed count and the destructive tick of an import by key are enforced by the browser (the server checks the count of a change by filter); a unique violation on apply can reveal that a written sensitive column collided with another row (as an edit of one row does); validation of a very large file with `listAll` can hold the page reads of a connection for up to 60 seconds. Only PostgreSQL 17 has been run so far.

## [Unreleased]

### Changed

- Development uses pnpm instead of npm (`pnpm install`, `pnpm run check`). The published package and `npx` are unchanged. See `docs/decisions.md`, decision 170.

## [1.11.1] - 2026-11-24

A patch to the 1.11.0 MCP server. Version 1.12.0 stays reserved for the write side's second part (`docs/write-side-v2-plan.md`). Nothing in this release writes.

**Upgrading:** the Claude app keeps its tool list until it reconnects, so restart Claude Desktop (or reconnect `datacanvas` in Claude Code) after updating.

### Fixed

- **Claude could not read rows or run queries when the data level was shared after it connected.** The data tools (`read_rows`, `run_readonly_query`, `explain_query`, `check_migration_against_data`) were listed only while some connection was shared at the data level, but a Claude app reads the tool list once, when it connects, and the server cannot tell it the list changed. Every tool is now listed at every level, and each call checks the level of its connection (a structure-level connection answers that it needs the data level; nothing runs). The prompts are listed the same way.

### Added

- **Sizes and objects for Claude.** `get_sizes` gives the size of the database, of each schema and of the largest tables (table, indexes and TOAST; a partitioned table counts its partitions), from the server's size functions: no row is read. `list_objects` gives the Objects tab's lists (views, types, sequences, functions, triggers, extensions, row-level security) as names and settings; view SQL, function and trigger bodies, domain defaults and checks and policy expressions are left out, because they can hold values. `describe_table` now also gives the table's size on disk, live and dead rows and when it was last vacuumed and analysed. Fifteen tools, still none that writes.
- **Troubleshooting for "Connection closed" in Claude Desktop**: the full path of `npx` and `env.PATH` when Node comes from nvm, Volta or Homebrew (`docs/agent-setup.md`, the site guide).

## [1.11.0] - 2026-11-24

### Added

- **Connect to Claude: read your database from a Claude app, read-only.** Under each connection, **Share with Claude** lets Claude Desktop, Claude Code or any MCP client read it through DataCanvas, over the Model Context Protocol. DataCanvas holds no API key and calls no cloud service: the Claude app you already use asks, DataCanvas answers locally. Decision 169, `docs/mcp-server-plan.md`.
  - **Two levels**, chosen per connection, kept in memory only (never saved; gone on a restart, a disconnect, and when viewing table data is switched off): **structure** (schemas, tables, columns, types, keys, indexes, foreign keys in both directions and the server's statistics: no row of any table) and **structure and data** (also rows, one page at a time, and read-only queries). The dialog says what leaves the machine before anything is shared; the data level needs a tick that rows are sent to Anthropic by the Claude app.
  - **Thirteen tools and no more** (a test pins the list): `list_connections`, `list_schemas`, `list_tables`, `describe_table`, `search_objects`, **`get_health`** (the Health tab's checks), **`find_path`** (the foreign-key route between two tables, with the join as text), **`compare_structure`** (the difference between two shared connections, such as staging and production) and **`generate_migration`** (the SQL, its rollback and its risks as text; nothing is run) at the structure level; and, at the data level only, `read_rows`, `run_readonly_query`, `explain_query` and **`check_migration_against_data`** (how many rows would make each step of a migration fail: counts, never a row). **There is no tool that writes.** Statements run through the SQL tab's runner (a read-only transaction on a connection of its own, one statement, limits); pages through the page reader that already hides sensitive-named columns.
  - **The schema as a document and ready prompts** (the MCP resources and prompts the plan had deferred): each shared connection's schema is a resource (Markdown data dictionary and a Mermaid diagram), and six prompts start the common jobs (find tables without a primary key, review the schema's health, explain the schema, how two tables are related, review a migration, tune a query). Nothing hidden gets in through the structure: defaults, comments and check definitions of hidden columns are left out, and views and functions are not described at all.
  - **You stay in control.** At the data level every call waits for your **Approve** (on by default; Escape does not answer it; two minutes, then it is refused), **Pause** refuses everything at once, at most 30 calls a minute are served, and a list shows **what Claude asked and how it ended** (counts, never a value that came back). Claude cannot approve or pause itself: those routes are behind the browser's cookie, which the token of the MCP door is not.
  - **Its own door.** `POST /mcp` has a token of its own (never the browser session's), refuses a web page (Host, `Origin`, `Sec-Fetch-Site`), and does not exist (404) while nothing is shared. The command `datacanvas mcp` is the bridge a Claude app starts; it finds the running DataCanvas by itself and says in plain words when there is none. The setup text is the same on every run and holds no secret.
  - **A database's own error text is not passed on** (it can hold a value: `invalid input syntax for type integer: "..."`): only errors about names, limits and our own refusals are. A statement that names a sensitive-looking column is refused; with `SELECT *` the column comes back as NULL. A superuser, or a role that can read server files or run programs, needs a second "Share anyway" (use a read-only database user).
- The server was read by a second reviewer before this release (docs/threat-model.md, section 13b), who reproduced a high finding and several medium ones against a real PostgreSQL, all fixed or said plainly: a statement could hide a sensitive column from the name check (a string holding `'/*'`), and `pg_stats` returned sampled values; the approval prompt showed only the first 2,000 characters of a statement; a cursor held the key of a hidden key column; an error message could quote a row; a statement kept running after Pause. **Hidden columns are described as a safety net, not a barrier**, because a model that is told to can still get around a name check (a whole-row value, a column alias list): use a database user that cannot read what must not leave. A Claude app that can run commands on your computer can reach the app's own controls, so approval protects against mistakes and not against such an app.
- **Adoption**: **copy-paste setup** for Claude Code (a command or a project `.mcp.json`), Claude Desktop, Cursor and VS Code, in a "Your app" picker of the Share dialog (the formats were read from each editor's documentation; none was tried in a real editor); a **Claude Code plugin** (`integrations/claude-code`: the MCP server and a `datacanvas` skill that teaches an agent the workflow, installable from this repository as a marketplace); and a **Docker image** (`Dockerfile`, `docs/docker.md`) with a guarded `--host` option: `0.0.0.0` is accepted only when `DATACANVAS_ALLOW_ANY_INTERFACE=1` (which the image sets), the Host check and both tokens are unchanged, and a request through a LAN address is still refused. In a container, Share with Claude works through `docker exec -i <container> datacanvas mcp`. `docs/agent-setup.md` ties it together.
- **Agent evals**: the twenty questions are now run through the real tools on the shop database (and the new tools on two databases), and a lint of the tool descriptions (length, level, "nothing is run", where each connection value comes from) keeps what a model reads small and clear.
- Documentation for it: README, the guide ("Use DataCanvas from Claude"), SECURITY.md, the threat model (section 13) and the documentation site.

### Fixed

- The **Export diagram** dialog (1.10.0) fell back to the narrowest dialog size, so its four buttons and its notice stuck out of the box. It uses the form size now, and a test checks that every control stays inside the dialog.

## [1.10.0] - 2026-11-24

### Security

- **A Content-Security-Policy with a nonce made for each page request** (the biggest open item of SECURITY.md since the security phase): a script runs only with the nonce, nothing runs from inline text, an inline handler or `eval`, the page connects only to its own server, and no other site can frame it. The whole end-to-end suite runs with a listener that fails any test whose page breaks the policy; it found exactly one violation (zod probing for `eval`, now switched off in the browser). Decision 163.
- The two low advisories through `monaco-editor` (`dompurify`) are gone: an override to `dompurify` 3.5.0, `npm audit` reports none.
- The new code was read by a second reviewer before this release (docs/threat-model.md, section 12b). It found no way to run a script in the page, read a value through the statistics or a plan, or get out of the quoting of a script that is run, and reproduced ten findings, none high, all fixed or accepted:
  - An INSERT script was only as exact as the session that wrote it: a recipient with another `DateStyle` could store April 3 as March 4 with no error, and a float lost digits. The export now fixes `DateStyle`, `IntervalStyle`, `extra_float_digits` and `bytea_output` for its transaction, and the script sets `standard_conforming_strings`, `DateStyle` and `IntervalStyle` with `SET LOCAL`.
  - A script made with sensitive-named columns left out no longer commits (it is not a copy of the table).
  - Export of chosen rows no longer fails at 500 rows with a composite uuid key (the request body limit).
  - Documentation files: a comment can no longer change the structure of the Markdown, a PlantUML body line cannot start like a directive, a comment or the end of the diagram, a name is not a link, and Mermaid and DBML names hold nothing their parsers could read as a directive or an escape.
  - Smaller: the newest of a manual and an automatic vacuum, a plan with an overflowing time, steps of a closed plan not drawn, the wording about what the documentation files hold.

### Added

- **A query plan viewer** in the SQL tab: **Explain as a tree** and **Explain analyze as a tree** show the plan with the cost, the rows the planner expected against the rows it got, the time and buffers of each step, and in words what deserves the eye (a wrong guess by 10 times or more, a large sequential scan, a sort or hash that used the disk, the step that holds most of the time). The plan is kept whole (up to 2 MB) and read as untrusted text with limits. Decision 164.
- **Statistics** in the table details: the share of NULLs, distinct values, width and order of each column, and the size, rows, dead rows and last vacuum and analyze of the table, from the server's own figures. No row and no value is read, and it needs no data-access switch. Decision 165.
- **Export documentation**: a Markdown data dictionary, and Mermaid, DBML and PlantUML diagrams of the whole database or one schema, made in the browser from the structure, with every name quoted for its format. Decision 166.
- **Export as a script of INSERT statements**, in one transaction, proved by a round trip against a real PostgreSQL; a cut script ends with `ROLLBACK;`. Decision 167.
- **Export the rows you chose**, with no write unlocked: a checkbox column in the grid, **Export chosen**, up to 500 rows read again by their keys on the server. Decision 168.

### Changed

- Every grid of a table with a key has a selection column (it was there only with writes unlocked).
- Dependencies: patch updates of vitest, typescript-eslint, axe-core and lucide-react.

### Fixed

- A NUL byte in a value that a bulk change was checked against is named as a NUL, not as a problem with the type of the key.
- The delimiter of a CSV file is found once for the file, not on every render.

## [1.9.0] - 2026-11-22

### Added

- **Change several rows together.** With writes unlocked, rows of an editable table can be chosen in the Data section (a checkbox on each row, Shift for a range, a box for the page; the choice is kept across pages and filters). **Set a value** puts one value in one column of all of them and **Delete rows** removes them, up to 500 at a time. Each row is the single-row statement, the whole change is one transaction, and if any row does not change exactly one row, nothing is written. A row that changed since you loaded it is left out and counted at the preview, without its values. Decision 159.
- **Import a CSV file.** **Import CSV** reads a file in the browser (UTF-8; comma, semicolon, tab or pipe; with or without a header; up to 100,000 rows, 50 columns and 20 MB), lets you choose a column of the table for each column of the file, say how empty fields and words such as `NULL` are read, and **Validate the file** against the table's rules without writing. **Apply** adds every row in one transaction in batches of 500, or none if any fails; **Cancel and roll back** stops it. A name in the file is never used as a name in a statement. Decision 160.

### Security

The write side was read by a second reviewer before this release (docs/threat-model.md, section 11b). It found no way to turn a file into a statement, to put a value in an error, a preview or a report, or to get past the three layers, and reproduced eleven findings, none a hole, all fixed:

- An import larger than 10 MB could not be sent: the framework cut the body and the page said it was not valid JSON. The limit now works (32 MB as JSON, 20 MB as a file), a cut body gets a clear answer, and the dialog says when an import is too large before sending it.
- A validation of many rows said "At least N rows pass" where N is an upper bound; it now says "At most".
- A bulk delete says plainly that it finds a row by its key and compares no values; a row named twice in different spellings of its key (`1` and `01`) is refused at the preview; a cancel during the last batch rolls back; a trigger that runs once for each statement is described as such; a lone half of a surrogate pair is refused; Shift-click no longer chooses a range from another page; an import with values for an identity column warns that the sequence does not move; a blank line in a one-column file is an empty value; at most two import previews are kept per connection.

### Changed

- Validation takes up to 100,000 rows (from 1,000) so that a file is checked whole, and the preview and the validation accept a request of up to 32 MB (a file of 20 MB is about 30 MB as JSON).
- The counts in the notices of a change use thousands separators ("100,000 rows were added.").

## [1.8.0] - 2026-11-21

### Security

The new read paths (validation, the pre-flight, export and the one-cell read) were read by a second reviewer before this release (docs/threat-model.md, section 10b). It found no way to change data and no value in a report or an error, and reproduced thirteen findings, none high, all fixed:

- An export that failed after its first byte could put the database's own message (which can hold a row value) in the server's log; the stream now ends with a fixed sentence.
- Export batches are sized by what they hold (a table of huge values is no longer read 1,000 rows at a time), and an export of a table with more than 100 columns no longer leaves the extra columns out silently.
- A validation now says what it could not check: a rule across columns that depends on a default, an exclusion constraint, partition bounds, an event trigger, and a key on a hidden column (which would have answered "does this value exist?"). `passed` is a lower bound when a rule fails more rows than it lists.
- A hidden column can no longer be used as the key of the one-cell read or counted by the pre-flight.
- A reader that stops receiving no longer holds an export's connection and slot.
- Ordering by a key column named like an output alias (`c0`, `r`, `s0`) was wrong in a page and an export; the key is now qualified by the table.
- Smaller fixes: names in an export's notes cut to one line, "cut" only when the table has more, a one-column CSV with empty values, a column called `_meta` in NDJSON.

### Added

- **Export the rows of a table as a file.** The **Export** button in the Data section writes the rows you are looking at, with the filter and the sort on screen, as **CSV**, **TSV**, **JSON** or **NDJSON**: up to 100,000 rows and 64 MB, streamed a batch at a time, with a line at the end that says when the file was cut. Columns whose names look sensitive are left out unless you showed them, and the file names them. A value a spreadsheet would run as a formula gets a leading apostrophe. Cancel stops the read in the database. Decision 158.
- **A JSON editor.** For a `json` or `jsonb` value: colours, the line and column where it stops being JSON, **Format** and **Minify** that keep every number and string exactly as written, a tree for a large document with a copyable path, and a comparison with the loaded value. Opened from a cell, the edit form and the add-row form. A value the grid cut short is read whole (up to 1 million characters; editing stops at the 100,000 characters a change can carry). Decision 156.
- **Validate** in the edit and add-row forms: asks the database whether it would accept the values, **without writing a row**. The values are checked in a temporary copy of the table inside a transaction that is switched to read-only before the first value goes in and is always rolled back. It names the rule that fails (NOT NULL, a CHECK, a value that does not fit, a unique key already taken, a missing parent) and what it did not check. The answer holds rule names, counts and row numbers, never a value. An event trigger in the database still fires while the temporary copy is made, and can write (a sequence can advance); the report says when one exists. Decision 157.
- **Check against the data** in the Migrations tab: with a live database as _From_, says how many rows would make a `SET NOT NULL`, a unique or primary key, a foreign key or a required column fail, before the script is run. It does not try a check constraint or a type change (their text can come from a snapshot file).

- **More ways to filter the rows of a table.** Up to ten conditions (from three); conditions can be put in a group so that any one of the group is enough ("A and (B or C)"); new conditions: ends with, does not contain, matches a pattern, is empty, is one of a list, is none of a list, is between, the date shortcuts (today, last 7 days, last 30 days, this month) on dates and timestamps, and for `json` and `jsonb` has the key, contains some JSON and the value at a path, for arrays contains all of, contains any of and is empty. **Filter by this value** from a cell, and **saved filters** per table (the columns and conditions, never the values). Decision 155.

### Fixed

- The columns table of the Table details tab can be scrolled by the keyboard on a narrow screen.

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
