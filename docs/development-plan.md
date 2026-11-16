# DataCanvas — Revised Phase-Wise Development & Learning Plan (v2)

> **Product vision:** An open-source, local-first visual database explorer. Connect a PostgreSQL database, explore its structure, understand relationships, and see everything on an interactive infinite canvas.
>
> **Core promise:** Your database. Your machine. Your control.
>
> **Install promise:** One command. Nothing else to install except Node.js.
>
> **Development philosophy:** Small, understandable increments. Every phase produces working software and ends with a learning checkpoint.

## What changed from v1

| Area | v1 | v2 |
|---|---|---|
| Frontend | React + Vite SPA | **Next.js (App Router)** |
| Backend | Separate Fastify server | **Next.js route handlers** (one app, one process) |
| Databases | PostgreSQL + MongoDB | **PostgreSQL only** (adapter interface kept so others can be added later) |
| Workspace storage | Browser IndexedDB | **Local files in `~/.datacanvas/`** (IndexedDB is per-origin, so a port change would lose workspaces) |
| Install | Phase 12, last-minute | **Designed from Phase 0; packaging spike in Phase 2**, finished in Phase 11 |
| Native dependencies | Not addressed | **None allowed** (keeps `npx` fast and reliable on every OS) |
| CLI parsing | Commander.js | Node built-in `util.parseArgs` (zero dependencies) |
| Phases | 17 (0–16) | **16 (0–15)**, MVP is 0–13 |

---

# 1. Product Overview

## 1.1 What We Are Building

A locally running database visualizer. Users can:

1. Run one command.
2. Have DataCanvas open in their browser.
3. Paste a PostgreSQL connection string (or fill in a short form).
4. See tables, views, columns, constraints, indexes and foreign keys.
5. Explore them on a draggable, zoomable canvas.
6. Save and restore canvas layouts.
7. Export diagrams when they explicitly choose to.

## 1.2 Core Principles

### Minimal installation (top priority)

The ordinary user must need **only Node.js 20+**. They must NOT need to:

- Clone the repository.
- Run `npm install` on a project, or build anything.
- Create `.env` files or any config file.
- Install or run a separate frontend or backend.
- Install Docker, PostgreSQL, or any other tool.
- Create an account.

How we guarantee this:

- The published package ships a **prebuilt** Next.js standalone build. No compile step on the user's machine.
- **No native modules** (no `keytar`, `sharp`, `better-sqlite3`, `pg-native`). `pg` is pure JavaScript. Next image optimization is disabled (`images.unoptimized`) so `sharp` is not needed.
- **Zero or near-zero runtime dependencies** in the CLI itself.
- Sensible defaults: fixed default port, auto-created data folder, no required configuration.
- A clear error if Node is too old, telling the user exactly what to do.

### Privacy

- Database connections happen on the user's machine.
- Credentials never leave the machine and are never sent to any DataCanvas server.
- Raw table rows are never read or uploaded. Only metadata is read. _(Superseded in part by 1.2.0: rows can be viewed when a person switches data viewing on for a connection, and still are never uploaded or stored. See `docs/data-viewer-plan.md`.)_
- Telemetry is off by default (and there is none in v1).
- No account required.
- Schema metadata can be sensitive, so export/share is always an explicit user action.

### Extensibility

- A database-agnostic adapter interface (`database-core`) so MySQL/MongoDB can be added later.
- Future Docker and desktop packaging reuse the same code.

### Learning

Each phase is small enough to understand. The AI assistant must not dump an entire phase of unexplained code.

---

# 2. Technology Stack

| Layer | Technology | Responsibility |
|---|---|---|
| Language | TypeScript | One language everywhere |
| Framework | **Next.js (App Router)** | UI + API (route handlers) in one app |
| Styling | Tailwind CSS | Styling |
| UI components | shadcn/ui | Reusable components |
| Canvas | @xyflow/react (React Flow) | Node/edge canvas |
| Layout | elkjs (pure JS), added when needed | Automatic graph layout |
| State | Zustand | Client UI and canvas state |
| Validation | Zod | Validate every API input |
| Database driver | `pg` | PostgreSQL connectivity |
| Logging | Pino (optional, server-side) | Structured logs without secrets |
| Unit/integration tests | Vitest | Tests |
| End-to-end | Playwright | Workflow tests |
| Package manager / monorepo | npm workspaces | Packages |
| CLI | Plain Node script + `util.parseArgs` | `datacanvas` command |
| Distribution | npm (`npx`) | Public distribution |
| Optional later | Docker, Tauri | Alternative distribution |

## 2.1 Why Next.js route handlers instead of a separate backend

A browser cannot speak the PostgreSQL protocol, and credentials must not live in browser code. So a server-side runtime is required, but Next.js already provides Node on the server. Route handlers (`app/api/**/route.ts`) can use `pg` directly.

Benefits: one app, one process, one port, no CORS, no proxy, simpler packaging.

**Rule:** route handlers stay thin. They do three things only: validate input with Zod, call a service, return JSON. All database logic lives in plain TypeScript packages (`database-core`, `postgres-adapter`) with no Next.js imports. This keeps the option to move to Fastify later without rewriting the database code.

## 2.2 Known Next.js gotchas (plan for these)

- Every database route handler must declare `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`.
- The `pg` pool and connection registry must be stored on `globalThis`, otherwise hot reload in dev leaks connections.
- In a monorepo, standalone output needs `outputFileTracingRoot` set to the repo root and `transpilePackages` for workspace TypeScript packages.
- Next.js must listen only on `127.0.0.1` (`next dev -H 127.0.0.1`; in production the CLI sets `HOSTNAME=127.0.0.1`).
- Verify the current Next.js version's minimum Node version in Phase 0 and use it as our documented minimum.

---

# 3. Target User Experience

## 3.1 Installation and launch

```bash
npx --yes datacanvas
```

This should:

1. Check Node.js version (clear message if unsupported).
2. Use port `4747`, or the next free port if occupied (and say so).
3. Start the bundled production Next.js server on `127.0.0.1` only.
4. Open the default browser.
5. Print the URL and "Press Ctrl+C to stop".

Optional global install: `npm install -g datacanvas`, then `datacanvas`.

The package name must be verified on npm **before Phase 0 finishes**, not at release time.

Future zero-Node options (not MVP): Docker image, or single-file executables.

## 3.2 First-run experience

One screen, one obvious action: **Connect PostgreSQL**.

- Primary path: **paste a connection string** (`postgresql://user:pass@host:5432/db`). It is parsed locally.
- Secondary path: a short form (name, host, port default 5432, database, username, password with show/hide, SSL mode).
- **Test Connection** button with clear, human-readable errors (wrong password, host unreachable, SSL problem, database does not exist).
- Recommend a read-only database user in the UI.
- No `.env` files, no config files.

## 3.3 Where data lives

| Data | Where | Notes |
|---|---|---|
| Database passwords | **Server memory only**, per session | Lost when DataCanvas stops. Never returned to the browser. Never written to disk in v1. |
| Connection profiles (name, host, port, db, user, SSL mode) | `~/.datacanvas/connections.json` | **No passwords.** The user re-enters the password on connect. |
| Workspaces (canvas layouts) | `~/.datacanvas/workspaces/*.json` | Versioned JSON. No credentials. |
| Logs | Terminal only by default | Never contain connection strings. |

The data directory is created automatically. The path can be overridden with `DATACANVAS_HOME` (optional, never required).

Why files and not IndexedDB: IndexedDB is tied to the origin including the port. If port 4747 is busy and DataCanvas starts on 4748, the user's saved workspaces would silently disappear. Files in the home folder do not have this problem.

## 3.4 Architecture

```text
                 USER
                   |
                   v
             WEB BROWSER
          http://127.0.0.1:4747
                   |
                   v
   +-------------------------------+
   |   NEXT.JS APP (one process)   |
   |                               |
   |   React UI (App Router)       |
   |          |                    |
   |   Route handlers (/api/*)     |
   |    validate (Zod) -> service  |
   +---------------|---------------+
                   v
           database-core (interfaces)
                   |
                   v
            postgres-adapter (pg)
                   |
                   v
              POSTGRESQL
```

The app binds to `127.0.0.1`, never `0.0.0.0`. There is no endpoint that runs arbitrary SQL.

---

# 4. Repository Architecture

Monorepo with npm workspaces. Introduce packages only when a phase needs them.

```text
datacanvas/
├── apps/
│   └── web/                      # Next.js app (UI + API route handlers)
│       ├── app/
│       │   ├── (ui routes)
│       │   └── api/              # thin route handlers
│       ├── components/
│       ├── features/             # connections, explorer, canvas, workspaces
│       ├── lib/server/           # connection registry, services, storage (server-only)
│       ├── stores/               # Zustand
│       └── next.config.ts
│
├── packages/
│   ├── cli/                      # the published `datacanvas` bin
│   │   ├── bin/datacanvas.mjs
│   │   └── src/
│   ├── database-core/            # interfaces + models (no pg, no Next)
│   ├── postgres-adapter/         # pg implementation
│   ├── shared-types/             # Zod schemas + inferred types, used by UI and routes
│   └── canvas-engine/            # (Phase 7+) node/edge models, layout, serialization
│
├── scripts/                      # build/pack scripts (assemble publishable package)
├── examples/                     # sample SQL for contributors
├── docs/
├── tests/
├── package.json
├── tsconfig.base.json
└── README.md
```

## 4.1 How the published package is assembled

`scripts/build-package` produces one folder that is published as `datacanvas`:

```text
datacanvas/ (published)
├── bin/datacanvas.mjs     # CLI entry
├── web/                   # Next.js standalone output + static assets
└── package.json           # "bin", "engines": { "node": ">=20" }, "files"
```

The CLI spawns `node web/server.js` with `HOSTNAME=127.0.0.1` and `PORT`. The user never runs Next.js tooling.

## 4.2 Package responsibilities

- **apps/web:** UI, route handlers, server-only services. Never imported by other packages.
- **packages/cli:** version check, port selection, start the bundled server, open browser, graceful shutdown.
- **packages/database-core:** adapter interface, metadata models, errors, provider registry. No driver dependencies.
- **packages/postgres-adapter:** connection, introspection, relationships, error mapping.
- **packages/shared-types:** Zod schemas and inferred types for API contracts.
- **packages/canvas-engine:** introduced in Phase 7 only if canvas logic outgrows `apps/web/features/canvas`.

---

# 5. Development Phases

Each phase lists: objective, tasks, concepts, checkpoint, completion criteria. Do not advance until the current phase is understood and working.

**Phases:** 0 Foundation · 1 App shell · 2 Route handlers + packaging spike · 3 Shared types · 4 Database core · 5 Postgres adapter · 6 Explorer · 7 Canvas · 8 Workspaces · 9 Advanced exploration · 10 Security · 11 CLI and one-command install · 12 Testing · 13 Release · 14 Docker (optional) · 15 Desktop (optional)

---

# PHASE 0 — Foundation

## Objective

Set up the repo and tooling, and settle the decisions that affect install simplicity.

## Tasks

1. Verify npm package name availability for `datacanvas` (pick a fallback now if taken).
2. Create the GitHub repo and initialize npm workspaces.
3. `tsconfig.base.json`, ESLint, Prettier, `.gitignore`.
4. Record the minimum supported Node version (from the chosen Next.js version's requirement).
5. Basic README and contributor guide (contributors use `npm install` and `npm run dev`; ordinary users never do). Include the **code documentation conventions** (file headers, "why" comments for complex logic, TSDoc on exported APIs) and create `docs/architecture.md`, which is extended every phase.
6. Add a short `docs/decisions.md` recording: Next.js route handlers, no native deps, file-based storage, in-memory passwords.

## Concepts to Learn

Monorepos, npm workspaces, TypeScript compilation and `tsconfig`, dev vs production dependencies, linting vs formatting, Node module resolution.

## Learning Checkpoint

Explain why a monorepo, how workspaces link packages, what `npm install` does, and how one workspace imports another.

## Completion Criteria

Repo exists, workspaces resolve, lint/format/typecheck run, package name decision made.

---

# PHASE 1 — Next.js App Shell

## Objective

Create the UI skeleton with no database functionality.

## Tasks

1. Create `apps/web` with Next.js (App Router, TypeScript, Tailwind).
2. Set `images: { unoptimized: true }` and `output: "standalone"` now, so we never depend on `sharp` later.
3. Install and configure shadcn/ui.
4. Layout: header, sidebar, empty workspace.
5. Welcome screen with a **Connect PostgreSQL** call to action (PostgreSQL only, no provider picker).
6. Reusable loading, empty and error components.
7. Learn the Server vs Client Component split: keep interactive parts as `"use client"`.

```text
+------------------------------------------------------+
| DataCanvas                         Settings          |
+---------------+--------------------------------------+
|               |                                      |
| Connections   |       Welcome to DataCanvas           |
|               |                                      |
|  (none yet)   |       Connect your first database     |
|               |                                      |
|               |       [ Connect PostgreSQL ]          |
+---------------+--------------------------------------+
```

## Concepts to Learn

App Router, layouts, Server vs Client Components, props and state, hooks, Tailwind, shadcn/ui, standalone output.

## Learning Checkpoint

Explain how Next.js renders a server component vs a client component, how state changes trigger re-renders, and why components should have single responsibilities.

## Completion Criteria

App runs on `127.0.0.1`, layout is responsive, reusable components exist, `next build` succeeds with standalone output.

---

# PHASE 2 — Route Handlers and the Packaging Spike

## Objective

Build the first API, and de-risk installation by proving early that the app can be launched from a packed tarball.

## Tasks

### 2.1 First API

1. `app/api/health/route.ts` returning `{ "status": "ok", "application": "datacanvas" }`.
2. Declare `runtime = "nodejs"` and `dynamic = "force-dynamic"`.
3. Frontend shows `Backend status: Connected`, with a graceful failure state.
4. A consistent error response shape (`{ error: { code, message } }`).

### 2.2 Packaging spike (walking skeleton)

1. `scripts/build-package` copies standalone output plus static assets into a publishable folder.
2. A minimal `bin/datacanvas.mjs` that picks a port, starts `web/server.js` bound to `127.0.0.1`, and opens the browser.
3. `npm pack`, then install the tarball in a **fresh temp folder** and run it with `npx`.
4. Confirm there is no `node-gyp`, no postinstall build, no native binaries in the tarball.

This spike is intentionally rough. Phase 11 polishes it. Doing it now means install problems are found at Phase 2, not at release.

## Concepts to Learn

HTTP, REST, status codes, route handlers, async/await, JSON, `npm pack`, `bin` entries, how `npx` resolves and runs a package, Next.js standalone output.

## Learning Checkpoint

Explain the lifecycle: React component → `fetch("/api/health")` → route handler → JSON → UI update. Then explain what `npx ./datacanvas-0.0.0.tgz` does.

## Completion Criteria

Health route works in dev and in the packed build; a fresh-folder `npx` run of the tarball opens the app.

---

# PHASE 3 — Shared Types and Validation

## Objective

A reliable contract between UI and route handlers.

## Tasks

1. Create `packages/shared-types` with Zod schemas and inferred types.
2. Define `PostgresConnectionInput` (connection-string mode and field mode), API response and error types.
3. Connection-string parsing and validation (never log it).
4. A helper used by every route handler: parse body with Zod, return a readable 400 on failure.
5. Use the same schemas in the UI forms.

Initial contract (refine as needed):

```typescript
type PostgresConnectionInput =
  | { mode: "string"; name: string; connectionString: string }
  | {
      mode: "fields";
      name: string;
      host: string;
      port: number; // default 5432
      database: string;
      username: string;
      password: string;
      sslMode: "disable" | "require" | "verify-full";
    };
```

## Concepts to Learn

Interfaces, unions, optional properties, runtime vs compile-time validation, Zod, type inference.

## Learning Checkpoint

Explain why TypeScript types cannot validate untrusted HTTP input and why server-side validation is mandatory even if the form validates.

## Completion Criteria

Schemas shared by UI and API; invalid requests return readable errors.

---

# PHASE 4 — Database Core

## Objective

Define the database-agnostic architecture. No real database yet.

## Tasks

1. Create `packages/database-core`.
2. Connection and adapter interfaces.
3. Metadata models: database, schema, table/view, column, constraint, index, relationship.
4. Error types (auth failed, unreachable, SSL, timeout, permission denied).
5. Provider registry (only `postgresql` registered for now).
6. A mock adapter used in tests and for UI development.

Initial interface:

```typescript
interface DatabaseAdapter {
  connect(): Promise<void>;
  testConnection(): Promise<void>; // throws typed errors
  getSchemas(): Promise<SchemaInfo[]>;
  getTables(schema: string): Promise<TableInfo[]>;
  getColumns(schema: string, table: string): Promise<ColumnInfo[]>;
  getIndexes(schema: string, table: string): Promise<IndexInfo[]>;
  getRelationships(): Promise<RelationshipInfo[]>;
  disconnect(): Promise<void>;
}
```

Keep it PostgreSQL-shaped where that is honest. Do not build abstractions for hypothetical databases.

## Concepts to Learn

Abstraction, interfaces, adapter pattern, registry pattern, dependency inversion, domain modeling.

## Learning Checkpoint

Why must route handlers not contain SQL? What would adding MySQL later involve?

## Completion Criteria

Interfaces and models exist; mock adapter implements them; `database-core` has no driver or Next.js dependency.

---

# PHASE 5 — PostgreSQL Adapter

## Objective

Connect to real PostgreSQL and extract its structure.

## Tasks

### 5.1 Connection

- `pg` with a small connection pool (e.g. max 3).
- Connect timeout, statement timeout, and `application_name = 'datacanvas'`.
- Map driver errors to typed errors: auth failure, unreachable host, SSL failure, database not found.
- SSL with certificate verification by default; `sslmode` honored.
- Safe, idempotent disconnect.

### 5.2 Discovery

Schemas (excluding `pg_*` and `information_schema` by default), tables, views, materialized views.

### 5.3 Introspection

Columns (name, type, nullable, default), primary keys, foreign keys, unique constraints, check constraints.

### 5.4 Indexes

Name, columns, uniqueness, method (btree, gin, etc.).

### 5.5 Relationships

Real foreign keys only. Cardinality from constraints (e.g. FK column also unique means one-to-one). Never present name-based guesses as confirmed foreign keys.

### 5.6 Safety

- All metadata queries are fixed, parameterized, read-only and bounded.
- Set `default_transaction_read_only` for the session where possible.
- Never read table rows. _(Superseded in part by 1.2.0, see `docs/data-viewer-plan.md`: only with the per-connection opt-in.)_

## Suggested structure

```text
packages/postgres-adapter/src/
├── connection/
├── introspection/   (schemas, tables, columns, indexes, relationships)
├── errors.ts
├── postgres.adapter.ts
└── index.ts
```

## Concepts to Learn

PostgreSQL system catalogs (`pg_catalog`) vs `information_schema`, connection pools, parameterized queries, constraints and indexes, SSL modes, resource cleanup.

## Learning Checkpoint

Create a test database (users, orders, products, order_items) with foreign keys. Explain exactly which catalog queries discover each table and relationship. Do not just copy queries; understand them.

## Completion Criteria

Metadata and foreign keys extracted; error cases handled; tests run against a disposable Postgres (contributors use Docker Compose in `examples/`; end users never need it).

---

# PHASE 6 — First Complete Explorer

## Objective

Connect adapter, route handlers and UI. First major milestone.

## Tasks

1. Server-side **connection registry** on `globalThis`: maps opaque connection IDs to live adapters. Passwords live only here.
2. Routes (all validated with Zod, all `runtime = "nodejs"`):

```http
POST   /api/connections/test
POST   /api/connections
GET    /api/connections
DELETE /api/connections/:id            (disconnect and drop credentials)
GET    /api/connections/:id/schemas
GET    /api/connections/:id/tables?schema=
GET    /api/connections/:id/tables/:table/columns?schema=
GET    /api/connections/:id/relationships
```

3. The UI never receives passwords. Responses use opaque IDs.
4. Connection form: paste-a-string first, fields second, Test Connection, readable errors.
5. Schema explorer tree, table detail (columns, constraints, indexes).
6. Loading, empty and error states.
7. Idle cleanup: close pools after a period of inactivity.

## Concepts to Learn

Route design, service layer, singleton on `globalThis`, connection lifecycle, error boundaries, data fetching in Next.js.

## Learning Checkpoint

Trace one action end to end: user pastes a connection string and clicks Connect → form → fetch → route handler → Zod → service → registry → adapter → `pg` → PostgreSQL → and back.

## Completion Criteria

A user can connect to PostgreSQL and explore its schema without writing SQL.

---

# PHASE 7 — Interactive Infinite Canvas

## Objective

Turn the explorer into a visual workspace.

## Tasks

### 7.1 Foundation

React Flow, zoom, pan, minimap, grid background, fit view.

### 7.2 Table nodes

Custom node showing table name, columns, types, PK/FK badges. Truncate very large tables (show first N columns with an expand control).

### 7.3 Interactions

Drag, select, multi-select, remove from canvas (never touches the database), add tables from the explorer.

### 7.4 Edges

Foreign-key edges with labels and cardinality markers. Visually distinguish confirmed vs user-defined relationships. (No automatic inference in v1.)

### 7.5 Controls

Zoom, fit view, reset layout, toggle grid, search tables, select all.

### 7.6 Basic automatic layout

A simple grid layout first. ELK.js only if the need is proven (Phase 9).

## Concepts to Learn

Graphs, nodes and edges, controlled React Flow state, coordinates and viewport transforms, Zustand, custom nodes, memoization.

## Learning Checkpoint

Explain how a node is represented in state, how edges reference nodes, how dragging updates coordinates, how zoom and pan work, and how canvas state differs from database metadata.

## Completion Criteria

A user can visualize their database on the canvas, move tables and see relationships. Performs acceptably with ~100 tables.

---

# PHASE 8 — Save and Restore Workspaces (file-based)

## Objective

Preserve layouts and connection profiles across restarts, with no setup.

## Tasks

1. Workspace model: node positions, visible tables, viewport, connection profile reference. **No credentials.**
2. Route handlers: `GET/PUT/DELETE /api/workspaces/:id`, `GET /api/workspaces`.
3. Storage service writes JSON to `~/.datacanvas/workspaces/` using atomic writes (write temp file, then rename).
4. `schemaVersion` field plus a migration function for future format changes.
5. Connection profiles saved to `~/.datacanvas/connections.json` **without passwords**. On reopen, the user is asked only for the password.
6. Rename, delete, export to a `.json` file, import from a `.json` file (validated with Zod).
7. Auto-save with debounce.
8. Handle a stale workspace: tables that no longer exist in the database are flagged, not crashed on.

## Concepts to Learn

Serialization, versioned file formats, atomic file writes, filesystem paths per OS (`os.homedir()`), debouncing, data migration.

## Learning Checkpoint

Explain how React Flow state becomes JSON, how it is stored and restored, and what happens when the format changes in a future version.

## Completion Criteria

Closing and reopening DataCanvas (even on a different port) restores the user's workspace and connection profile.

---

# PHASE 9 — Advanced Exploration

## Objective

Make DataCanvas useful on large, real schemas.

## Tasks

1. **Inspector panel:** details, columns, constraints, indexes, relationships, row-count estimate from `pg_class.reltuples` (no row scans).
2. **Search:** by table and column, jump to node.
3. **Filters:** show/hide schemas, views, specific tables.
4. **Relationship exploration:** highlight connected tables, focus mode, hide unrelated, expand dependencies by N hops.
5. **Layout:** ELK.js hierarchical and compact layouts, reset positions.
6. **Export:** PNG and SVG of the canvas, plus a clear notice that schema information may be sensitive.

## Concepts to Learn

Graph traversal (BFS/DFS), layout algorithms, search indexing, memoization, performance optimization.

## Learning Checkpoint

Independently implement a small BFS exercise, then explain how DataCanvas uses it to highlight connected tables.

## Completion Criteria

Users can explore complex databases without manually arranging every node.

---

# PHASE 10 — Security Hardening

## Objective

Make the local-first design safe enough for a public release.

## Tasks

### 10.1 Local server protection

- Bind only to `127.0.0.1` (verified by a test).
- **Host header validation** (blocks DNS rebinding): only accept `127.0.0.1:<port>` and `localhost:<port>`.
- **Origin validation** on all state-changing requests.
- **Per-run session token:** the CLI generates a random token at startup and opens the browser at a URL carrying it; the app exchanges it for an `HttpOnly`, `SameSite=Strict` cookie. Invisible to the user, but blocks other local processes and malicious websites.
- Enforce checks in middleware **and** inside route handlers (defense in depth).

### 10.2 Credentials

- Never return credentials in any response. Never log connection strings (redact in errors).
- Passwords are memory-only in v1. Clear disconnect and "forget credentials" operations.
- Do not add OS-keychain storage in v1 (it requires native modules, which conflicts with the install goal). Revisit later.

### 10.3 Database access

- Recommend read-only users, TLS with verification, timeouts, bounded queries.
- No arbitrary SQL endpoint, ever.

### 10.4 Application security

- Dependency audit and scanning in CI, security tests, safe error messages.
- Telemetry stays off.

### 10.5 Documentation

A transparent `SECURITY.md` and privacy page: where credentials live, what is read (metadata only, as originally planned; rows too if data viewing is switched on, see `docs/data-viewer-plan.md`), what is written to disk, what leaves the machine (nothing), and what to consider before exporting diagrams.

## Concepts to Learn

CSRF, CORS, origin validation, DNS rebinding, localhost attack surface, secret handling, TLS, least privilege, threat modeling.

## Learning Checkpoint

Write a threat model: assets, attackers, what a malicious website can attempt against `127.0.0.1`, what happens on connection failure, what could leak through logs.

## Completion Criteria

Documented threat model, tested controls, no known critical issues in scope. Do not claim "completely secure".

---

# PHASE 11 — CLI and One-Command Install

## Objective

Finish and polish the install experience started in the Phase 2 spike.

## Tasks

### 11.1 CLI behavior

1. Node version check with an actionable message.
2. Default port 4747; if busy, choose a free port and say so. If another DataCanvas instance is already running on 4747, open it instead of starting a second one.
3. Start bundled server on `127.0.0.1`, wait until healthy, then open the browser (macOS `open`, Windows `start`, Linux `xdg-open`; print the URL if opening fails, e.g. on a headless machine).
4. Handle Ctrl+C / SIGTERM: close database pools, stop the server, exit cleanly.
5. Flags via `util.parseArgs`: `--port`, `--no-open`, `--version`, `--help`. Nothing else in v1.
6. A first-run welcome line; create `~/.datacanvas/` automatically.

### 11.2 Production packaging

- Published package contains only the CLI and the prebuilt `web/` standalone output.
- `engines.node` set; `files` allowlist; no `postinstall` scripts; no native dependencies.
- **Test the packed tarball**, not the monorepo.
- Track package size and cold-start time (`npx` first run should feel fast).

## Concepts to Learn

Node CLI development, process management, signals, graceful shutdown, `npx` resolution and caching, port discovery, package `exports`/`bin`.

## Learning Checkpoint

Explain exactly what happens on `npx --yes datacanvas`: npm resolution and cache, bin execution, server startup, static asset serving, browser launch, and shutdown.

## Completion Criteria

A new user with only Node installed can run DataCanvas in one command, with no clone, no build and no configuration.

---

# PHASE 12 — Testing and QA

## Tasks

- **Unit (Vitest):** metadata transforms, relationship/cardinality logic, connection-string parsing, workspace serialization and migration, Zod schemas.
- **Integration:** postgres-adapter against a disposable Postgres (Docker/Testcontainers in CI), route handlers, connection lifecycle, error mapping, security controls (bad Host, bad Origin, missing token).
- **End-to-end (Playwright):** launch from the packed tarball, connect, browse tables, open canvas, move a node, save, reload, restore, disconnect.
- **Install QA:** clean machine/CI runners on macOS, Windows and Linux; unsupported Node version; port conflict; unreachable database; wrong password; SSL failure.
- **Performance:** a schema with several hundred tables.

## Completion Criteria

Core flows pass automatically in CI on all three operating systems, and a clean-environment `npx` run works.

---

# PHASE 13 — GitHub and npm Release

## Tasks

- README with screenshots and a short demo GIF; the first screen of the README shows the one-line install.
- Getting-started, architecture and security docs, contributing guide, issue/PR templates, changelog.
- GitHub Actions: lint, typecheck, tests, build, release, npm publish (trusted publishing or a tightly scoped token). **Publishing to npm and GitHub needs the maintainer's own credentials and approval.**
- Verify package name, metadata, `bin`, `engines`, license, tarball contents, and install on a clean machine.
- Target: **DataCanvas v1.0.0** with PostgreSQL support, local-first execution, canvas, schema explorer, relationship visualization, saved workspaces and export.

## Completion Criteria

A developer finds the repo, runs one `npx` command and uses DataCanvas with no development setup.

---

# PHASE 14 — Docker Distribution (optional)

- Production Dockerfile and Compose example; persistent volume for `~/.datacanvas`.
- Document that `localhost` inside a container is not the host. Show `host.docker.internal` and Compose-network examples.
- Binding: inside a container the app must listen on `0.0.0.0` but publish only to the host loopback (`-p 127.0.0.1:4747:4747`). Document the security implications.

---

# PHASE 15 — Desktop Application (optional)

- Tauri shell reusing the same Next.js standalone build and adapters, with native menus, file import/export, signing and notarization.
- Note: a desktop build would need to bundle a Node runtime or sidecar; evaluate then.

---

# 6. Learning Workflow — Mandatory After Every Phase

## Step 1 — Review the changes

Ask the AI assistant for: files created, modified and deleted; the purpose of each; new dependencies; new architectural decisions; important functions.

## Step 2 — Understand the code

For each important file: what is it responsible for, why does it exist, what does it import, what imports it, what happens when its functions run, what breaks if it is removed, could the responsibility live elsewhere?

## Step 3 — Trace execution

Follow complete flows, not isolated files. Example:

```text
User clicks Connect
  -> React handler
  -> frontend fetch helper
  -> POST /api/connections
  -> route handler
  -> Zod validation
  -> connection service
  -> connection registry (globalThis)
  -> postgres-adapter
  -> pg driver
  -> PostgreSQL
```

Then trace the response back.

## Step 4 — Ask the assistant to teach it

```text
I have completed the current DataCanvas development phase.
I want to understand the implementation before proceeding.

Teach me the changes made in this phase.

1. Explain every important file created or modified.
2. Explain the purpose of each dependency introduced.
3. Explain the architecture and why it was chosen.
4. Explain the important functions and classes.
5. Trace the complete execution flow.
6. Explain how the UI, route handlers and packages communicate.
7. Identify any design patterns used.
8. Explain alternatives and trade-offs.
9. Highlight security and performance considerations.
10. Explain common errors and how to debug them.

Do not generate more code yet.
Assume I understand React and TypeScript reasonably well,
but explain backend-specific concepts from the fundamentals.
Use practical examples from DataCanvas.
```

## Step 5 — Test your understanding

```text
Create a learning assessment for the current DataCanvas phase.

Include 5 conceptual questions, 3 code-reading questions,
2 debugging scenarios and 1 small practical modification task.

Ask one question at a time. Do not reveal the answer immediately.
Evaluate my response, correct misunderstandings and explain the reasoning.
```

## Step 6 — Modify something yourself

Independently make one small change before moving on: a new API field, a validation rule, a loading state, a metadata property, an inspector section, a canvas interaction.

---

# 7. AI Development Rules

1. **One phase at a time.** Never silently start a later phase.
2. **Small, reviewable changes**, each with an objective, limited file changes and a test.
3. **Explain architectural decisions** and dependencies before introducing them.
4. **No premature abstraction.** Build for known requirements (PostgreSQL), keep reasonable extension points.
5. **No unexplained dependencies.** Each has a documented purpose. **No native modules and no `postinstall` scripts** (install-simplicity rule).
6. **Preserve type safety.** Avoid `any`, needless assertions, duplicate types and unvalidated input.
7. **Test every meaningful change** and run lint, typecheck and tests before claiming completion.
8. **No giant code dumps.** Break large tasks into steps.
9. **Install simplicity is a requirement.** Any change that adds a user-facing setup step needs explicit justification.
10. **Document the codebase as we build it.** Documentation is part of every task, not a cleanup step at the end:
    - **File header:** every non-trivial file starts with a short comment saying what it is responsible for and where it fits (for example, "Server-only registry mapping opaque connection IDs to live adapters").
    - **Complex logic gets comments that explain WHY**, not what the line does. This includes catalog SQL queries (what each join and filter is for), cardinality detection, `globalThis` singletons, atomic file writes, DNS-rebinding and origin checks, graph traversal and layout code, workspace migrations, and graceful shutdown.
    - **TSDoc on exported functions, types and interfaces** in the packages (`database-core`, `postgres-adapter`, `shared-types`, `cli`): purpose, parameters, return value, thrown errors, and any security or performance note.
    - **Non-obvious decisions** are marked in code with a short reason, and larger ones are recorded in `docs/decisions.md`.
    - **No noise:** do not comment obvious code (`// increment i`). Prefer clear names first, comments second.
    - **Keep docs in sync:** when behavior changes, update the comment, the relevant `docs/` page and the README in the same change.
    - Each phase also updates `docs/architecture.md` (how the pieces fit together and the request flows traced in the learning checkpoint).

---

# 8. Definition of Done for Every Phase

- [ ] Requested functionality works.
- [ ] No regressions.
- [ ] TypeScript, lint and relevant tests pass.
- [ ] Error cases handled.
- [ ] No unnecessary dependencies; none native.
- [ ] The packed package still launches with one command (from Phase 2 onward).
- [ ] New files have clear responsibilities and a header comment.
- [ ] Complex logic is commented with the reason it works that way; exported APIs have TSDoc.
- [ ] `docs/architecture.md`, `docs/decisions.md` and the README are updated for this phase.
- [ ] I understand the important code and can explain the flow.
- [ ] I can make a small modification independently.

---

# 9. MVP Scope

| Feature | MVP |
|---|---|
| One-command local install (`npx`) | Yes |
| PostgreSQL | Yes |
| Schema, table, column, index and constraint explorer | Yes |
| Foreign-key relationships | Yes |
| Infinite canvas, drag, zoom, pan | Yes |
| Basic and ELK automatic layout | Yes |
| Workspace persistence (local files) | Yes |
| Export PNG/SVG | Yes |
| MongoDB | Deferred |
| Inferred relationships | Deferred |
| Saved passwords / OS keychain | Deferred |
| Cloud accounts, team features, AI analysis | No |
| Docker, desktop app | Optional, after v1 |

---

# 10. Estimated Build Time

Rough AI build time per phase, including tests and lint. Excludes your review and learning time.

| Phase | Build time |
|---|---|
| 0 Foundation | 15–30 min |
| 1 App shell | 45–90 min |
| 2 Route handlers + packaging spike | 45–75 min |
| 3 Shared types | 20–40 min |
| 4 Database core | 30–45 min |
| 5 Postgres adapter | 1–2 hr |
| 6 Explorer | 1.5–3 hr |
| 7 Canvas | 2–4 hr |
| 8 Workspaces (files) | 45–90 min |
| 9 Advanced exploration | 2–4 hr |
| 10 Security | 1.5–3 hr |
| 11 CLI and install polish | 1–2 hr |
| 12 Testing and QA | 2–4 hr |
| 13 Release | 1–2 hr |
| **Total, MVP (0–13)** | **about 15–34 hours** |
| 14 Docker (optional) | about 1 hr |
| 15 Desktop (optional) | 3–6+ hr |

- **Usable PostgreSQL visualizer** (phases 0–8): about 8–16 hours.
- **Calendar time** is dominated by the mandatory learning checkpoints: roughly 4–8 weeks part-time.
- Items needing the maintainer: npm and GitHub publishing credentials, Windows/Linux verification (done through CI), and Docker for running the test database.

---

# 11. Future Ideas (post-MVP)

- MongoDB adapter (field sampling, clearly labelled inferred relationships).
- Schema comparison and migration visualization.
- Impact explorer and generated documentation.
- Optional AI schema assistant (only with explicit consent per request).
- Opt-in saved credentials via OS keychain, as a separate optional package.
- Single-file executables for users without Node.

---

# 12. Final Development Sequence

```text
Foundation
   -> Next.js app shell
   -> Route handlers + packaging spike
   -> Shared types and validation
   -> Database core
   -> PostgreSQL adapter
   -> Explorer
   -> Canvas
   -> File-based workspaces
   -> Advanced exploration
   -> Security hardening
   -> CLI polish and one-command install
   -> Testing and QA
   -> GitHub + npm release
   -> (optional) Docker, Desktop
```

## Final Product Goal

```bash
npx --yes datacanvas
```

Then connect a database and explore it visually. No account. No cloud. No `.env`. No manual frontend or backend setup. Only Node.js required.

**Build slowly enough to understand it, but architect it well enough that it can become a serious open-source product.**
