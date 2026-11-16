# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project intends to follow [Semantic Versioning](https://semver.org/) from 1.0.0.

## [Unreleased]

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
