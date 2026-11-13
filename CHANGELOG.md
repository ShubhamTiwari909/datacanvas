# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project intends to follow [Semantic Versioning](https://semver.org/) from 1.0.0.

## [Unreleased]

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
