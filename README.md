# DataCanvas

**See your PostgreSQL database as a map.** Connect, explore tables and relationships on an interactive canvas, and keep your layouts. It runs on your computer and nothing leaves it.

```bash
npx --yes @shubhamtiwari909/datacanvas
```

That is the whole installation. You only need [Node.js](https://nodejs.org) 20.9 or newer: no clone, no build, no `.env` file, no account. It prints a private link and opens your browser; press Ctrl+C to stop.

![The schema overview: one card per schema with counts, connections and the most connected tables](docs/images/overview.png)

![The paths tab: the shortest route between two tables and the generated join SQL](docs/images/paths.png)

![The health tab: findings grouped by check, with an explanation, a fix and SQL to copy](docs/images/health.png)

![The DataCanvas canvas showing a sample shop database: tables, relationships and the inspector panel](docs/images/canvas.png)

![The same canvas in dark mode](docs/images/canvas-dark.png)

## What you can do

- **Connect** to PostgreSQL with a connection string or separate fields. Passwords are kept in memory only.
- **Get an overview** of the whole database: per schema, how many tables and views, how they connect to other schemas, the most connected tables, the largest tables and tables without relationships.
- **Find a path** between two tables: the shortest chain of foreign keys, the columns joined at each step, and a ready-to-copy `SELECT … JOIN …` (text only; DataCanvas never runs SQL).
- **Check the model**: tables without a primary key, foreign keys without a supporting index, foreign keys whose column types differ, duplicate, redundant and unused indexes (from the server's own usage counters), optional (nullable) foreign keys, names that break the database's own style and very wide tables, each with an explanation and SQL you can copy (DataCanvas never runs it).
- **See beyond tables**: view definitions and what each view reads, enums and other types, sequences, functions, triggers, extensions and row-level-security policies (definitions and settings only; no rows are read).
- **Snapshot and compare**: save the structure now, then compare it later with the live database, another snapshot or a different database. It lists added, removed and changed tables, columns, indexes, constraints, foreign keys and those objects, which is useful for drift and reviews. Snapshots hold structure only (no rows, no credentials) and can be exported as files.
- **Explore** schemas, tables, views, materialized views and foreign tables, with columns, keys, indexes, constraints and row-count estimates.
- **See relationships** drawn as edges with their cardinality (1:1, 1:N, N:1), including across schemas.
- **Arrange** tables on an infinite canvas: drag, zoom, auto-layout (hierarchical, grouped, compact), search, filters, and focus on one table and its neighbours.
- **Save** layouts per connection; they are restored the next time you connect.
- **Export** a diagram as PNG or SVG, or a workspace as a file.
- **Light and dark themes**, or follow your system (button in the top bar).

## Your database, your machine, your control

- Everything runs locally and listens on `127.0.0.1` only.
- Only **metadata** is read (names, types, keys, indexes). Table rows are never read and there is no way to run your own SQL.
- No telemetry, no cloud, no account.
- The local server refuses requests from other websites and other programs (Host, Origin and a per-run session token).

Read [SECURITY.md](SECURITY.md) for exactly what is stored, what is read, and the known limits. DataCanvas has not had an independent security review.

## Quick start

1. Run `npx --yes @shubhamtiwari909/datacanvas`.
2. Open the private link it prints (a browser opens by itself when it can).
3. Choose **Connect PostgreSQL**, paste a connection string, and press **Connect**.
4. Add tables to the canvas from the schema list, or use the grid button beside a schema to add all of its tables.

More detail, including tips for read-only users and TLS, is in [docs/getting-started.md](docs/getting-started.md).

## Options

Add them after the command, for example `npx --yes @shubhamtiwari909/datacanvas --port 4900 --no-open`. Once installed globally (`npm install -g @shubhamtiwari909/datacanvas`) the command is just `datacanvas`.

```text
datacanvas [options]

  --port <number>   Port to listen on (default 4747, or the next free port)
  --no-open         Do not open the browser automatically
  -v, --version     Print the version
  -h, --help        Show help
```

Your data lives in `~/.datacanvas` (set `DATACANVAS_HOME` to change it). Starting DataCanvas a second time opens the one that is already running.

## For contributors

Requirements: Node.js 20.9 or newer and npm 10 or newer.

```bash
git clone https://github.com/ShubhamTiwari909/pg-visualizer.git
cd pg-visualizer
npm install              # installs every workspace and links them together
npm run app              # builds the app and runs it from this clone (about a minute the first time)
npm run dev              # development mode: builds the packages, then starts the web app at http://127.0.0.1:4747
npm run check            # format check + lint + typecheck + tests
npm run package          # assembles the publishable npm package in .package/
npm run verify:package   # packs it, installs the tarball in an empty project, tests the command
npm run test:e2e         # browser tests against the packaged app (needs a test PostgreSQL)
```

Integration and browser tests need a disposable PostgreSQL: see [examples/docker-compose.yml](examples/docker-compose.yml).

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions, [docs/architecture.md](docs/architecture.md) for how the pieces fit together, and [docs/decisions.md](docs/decisions.md) for why.

```text
apps/web/           Next.js app: the interface and the /api route handlers
packages/
  shared-types/     Constants and Zod schemas (API contracts)
  database-core/    Database-agnostic models, adapter interface, errors, mock adapter
  postgres-adapter/ PostgreSQL implementation: connections and catalog introspection
  canvas-engine/    Pure canvas logic: sizing, layout, edges, graph, search, filters
  cli/              The `datacanvas` command
scripts/            Package assembly and verification
e2e/                Playwright browser tests
tests/              Architecture and security rule tests
examples/           Sample database and a disposable PostgreSQL
docs/               Architecture, decisions, threat model, guides
```

The project was built in phases; the original plan is kept in [docs/development-plan.md](docs/development-plan.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Third-party packages keep their own licenses; one of them (`elkjs`, used for automatic layouts) is dual-licensed EPL-2.0 OR GPL-3.0-or-later. See [docs/decisions.md](docs/decisions.md) (decisions 69, 90 and 91).
