# Architecture

This page is extended in every phase. It describes how the pieces fit together today and where they are headed.

## Phase 0: foundation

Nothing user-facing exists yet. The repo contains the build tooling and two placeholder packages that prove the workspace wiring.

```text
pg-visualizer/
├── package.json          root: workspaces, shared scripts, dev tooling
├── tsconfig.base.json    compiler settings shared by every package
├── tsconfig.json         "solution" file: lists the packages for `tsc -b`
├── eslint.config.js      lint rules (bugs and bad patterns)
├── .prettierrc.json      formatting rules
└── packages/
    ├── shared-types/     exports APP_NAME and DEFAULT_PORT
    └── cli/              imports them; prints a message
```

## How a workspace imports another

1. The root `package.json` declares `"workspaces": ["apps/*", "packages/*"]`.
2. `npm install` finds each workspace and creates a symlink for it inside the root `node_modules` (for example `node_modules/@datacanvas/shared-types` points to `packages/shared-types`).
3. `packages/cli` lists `@datacanvas/shared-types` in its `dependencies`, so Node resolves `import ... from "@datacanvas/shared-types"` through that symlink to `packages/shared-types/package.json`, whose `exports` field points at `dist/index.js`.
4. For the compiler, `packages/cli/tsconfig.json` has a project `reference` to `../shared-types`. `tsc -b` builds shared-types first, then cli reads its generated `.d.ts` files.

Because the entry point is the compiled `dist/` output, a package must be built before another can run against it. `npm run build` handles the ordering.

## How the build works

`npm run build` runs `tsc -b` (build mode) at the root. It reads `tsconfig.json`, follows the `references`, and for each package compiles `src/` to `dist/` (JavaScript, type declarations and source maps). Incremental build info is cached so unchanged packages are skipped.

## Target architecture (from the plan)

```text
Browser -> Next.js app (UI + /api route handlers, one process, 127.0.0.1)
              -> database-core (interfaces)
                   -> postgres-adapter (pg)
                        -> PostgreSQL
```

Route handlers stay thin: validate with Zod, call a service, return JSON. The details are added phase by phase.

## Phase 1: the web app shell (`apps/web`)

A Next.js 16 App Router app. It has no API and no database code yet.

```text
apps/web/
├── app/
│   ├── layout.tsx        root layout (Server Component), sets <html>/<body> and metadata
│   ├── page.tsx          "/" route: AppShell + WelcomePanel
│   ├── loading.tsx       route-level loading UI (shown while the page is working)
│   ├── error.tsx         route-level error boundary (Client Component)
│   └── globals.css       Tailwind import + shadcn theme variables
├── components/
│   ├── layout/           Header, Sidebar, AppShell (page frame)
│   ├── states/           LoadingState, EmptyState, ErrorState (reused by every later phase)
│   └── ui/               shadcn/ui primitives (Button, Dialog), generated, owned by us
├── features/connections/ ConnectPostgresButton (client), WelcomePanel
├── lib/utils.ts          `cn()` helper for merging Tailwind class names
├── next.config.ts        standalone output, unoptimized images, monorepo trace root
├── postcss.config.mjs    Tailwind v4 PostCSS plugin
└── tsconfig.json         extends the base but uses bundler module resolution
```

### Server vs Client Components

By default every file in `app/` is a **Server Component**: it renders on the server and sends HTML, with no JavaScript for that component. A file is a **Client Component** only if it starts with `"use client"`; that is required when it uses state, effects or browser events.

| Component                                                                                               | Kind   | Why                                                            |
| ------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| `layout.tsx`, `page.tsx`, `AppShell`, `Header`, `Sidebar`, `WelcomePanel`, `EmptyState`, `LoadingState` | Server | Pure markup, no interactivity                                  |
| `ConnectPostgresButton`                                                                                 | Client | Owns `useState` for "is the dialog open?"                      |
| `ErrorState`, `app/error.tsx`                                                                           | Client | Has click handlers; error boundaries must be client components |

Rule of thumb: keep `"use client"` on the smallest, leaf-most component that needs it.

### Packaging-related settings

- `output: "standalone"`: `next build` writes `.next/standalone/` containing `server.js` and only the `node_modules` it needs (about 50 MB). Phase 2 packages this folder into the npm package.
- `outputFileTracingRoot` points at the repo root, otherwise files outside `apps/web` would be missing from the standalone folder.
- `images.unoptimized`: avoids the native `sharp` dependency.
- `dev` runs `next dev -H 127.0.0.1 -p 4747`, so the dev server is only reachable from this machine.

### Build order

`apps/web` imports `@datacanvas/shared-types`, which resolves to that package's compiled `dist/`. So the root `dev` and `build` scripts run `tsc -b` first to build the packages, then start Next.js.

## Phase 2: route handlers, the CLI launcher and the packaged app

### The first API: `GET /api/health`

```text
BackendStatus (client component)
      |  useBackendStatus() -> fetch("/api/health")
      v
Next.js server (same process, same port)
      |  app/api/health/route.ts: GET()
      v
Response.json({ status: "ok", application: "datacanvas" })
      |
      v
Hook checks the body at runtime, sets state "connected", UI re-renders
```

- A **route handler** is a `route.ts` file that exports a function named after an HTTP method. Next.js calls it with the request and expects a `Response`.
- Every handler declares `runtime = "nodejs"` (not Edge) and `dynamic = "force-dynamic"` (never cached or prerendered).
- `app/api/[...path]/route.ts` catches unknown `/api/*` URLs and returns the standard JSON error, so clients never receive an HTML 404 from an API URL. More specific routes (like `/api/health`) always win over the catch-all.
- Every error uses one shape, `{ "error": { "code", "message" } }`, built by `lib/server/api-response.ts` (type in `@datacanvas/shared-types`).
- The UI treats the server as unreachable on a network error, a 3 second timeout, a non-2xx status or an unexpected body, and offers a Retry button.

### The CLI launcher (`packages/cli`)

| File            | Responsibility                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `index.ts`      | Parse flags (`--port`, `--no-open`, `--version`, `--help`), check the Node version, orchestrate startup and shutdown   |
| `port.ts`       | Test a port on 127.0.0.1; try 4747, then the next free ports, then ask the OS                                          |
| `web-server.ts` | Spawn the bundled `server.js` with `HOSTNAME=127.0.0.1`, poll `/api/health`, stop it (SIGTERM, then SIGKILL after 5 s) |
| `browser.ts`    | Open the default browser with the OS launcher (`open`, `xdg-open`, `cmd /c start`)                                     |
| `version.ts`    | Version injected by esbuild at bundle time                                                                             |

Startup order: Node check, parse arguments, locate `server.js`, choose port, spawn server, wait for health, print URL, open browser. An explicit `--port` that is busy is an error; the default port quietly falls back to the next free one.

### How the npm package is assembled (`scripts/build-package.mjs`)

`npm run package` runs the normal build, then assembles `.package/`:

```text
.package/
├── bin/datacanvas.mjs     CLI (esbuild bundle; shared-types is inlined)
├── web/apps/web/          Next.js standalone server.js, .next/server and .next/static
├── node_modules/          server runtime deps (next, react, react-dom, ...), lifted to the root
├── package.json           generated
└── README.md
```

Problems found and solved while building this (each has a comment in the script):

1. **`sharp` is shipped even with unoptimised images.** The standalone tracer copies the native image library and a macOS-only binary. The script prunes `sharp`, `@img`, `@emnapi` and `detect-libc`, then fails if any `.node` file remains.
2. **`npm pack` drops nested `node_modules`.** The runtime dependencies are therefore moved to the package root and declared in both `dependencies` and `bundleDependencies`. Node still finds them because module resolution walks up from `web/apps/web/server.js`.
3. **The CLI imports a workspace package** (`@datacanvas/shared-types`) that does not exist on npm. esbuild bundles it into the single CLI file.

Result: a ~3.4 MB tarball, no native code, no install scripts. Installing it offline works, which proves nothing is downloaded.

### Verifying the packed package (manual spike)

```text
npm run package
cd .package && npm pack --pack-destination <scratch folder>
cd <fresh empty folder> && npm install --offline <path to .tgz>
./node_modules/.bin/datacanvas --no-open
```

## Phase 3: shared contracts and request validation

### Why runtime validation exists

TypeScript types are erased when the code is compiled. A JSON body arriving over HTTP is just text that happens to parse; nothing guarantees its shape. A **Zod schema** is ordinary runtime code that checks a value and, as a bonus, produces the matching TypeScript type (`z.infer`), so the validator and the type cannot drift apart. The browser validates for fast feedback; the **server must validate again**, because anyone can call the API without our UI.

### `@datacanvas/shared-types`

```text
packages/shared-types/src/
├── constants.ts            APP_NAME, DEFAULT_PORT (no Zod: the CLI imports only this)
├── health.ts               healthResponseSchema
├── api-error.ts            error codes, validationIssueSchema, apiErrorResponseSchema
├── postgres-connection.ts  connection input schemas, connection-string parser, summary
└── index.ts                re-exports everything
```

`"sideEffects": false` lets esbuild drop modules the CLI does not use, so the CLI bundle stays about 7 KB instead of embedding Zod.

### The PostgreSQL connection contract

```text
browser sends                     server works with                server may reveal
─────────────────────────         ─────────────────────────        ─────────────────────────
{mode:"string", name,             ResolvedPostgresConnection       PostgresConnectionSummary
 connectionString}      ──┐       {name, host, port, database,      {name, host, port, database,
{mode:"fields", name,     ├─►      username, password, sslMode}      username, sslMode,
 host, port, ...}       ──┘       (HAS THE PASSWORD)                  hasPassword}  (NO password)
      postgresConnectionInputSchema     resolvePostgresConnection()      summarizePostgresConnection()
```

- Two entry modes share field rules. `z.discriminatedUnion("mode", ...)` picks the schema from the `mode` field.
- `z.strictObject` rejects unknown keys (no accidental mass-assignment).
- Types are **not coerced**: a port sent as the string `"5432"` is rejected. The UI converts before sending.
- Defaults: port 5432, empty password, `sslMode` "verify-full" (encrypted, certificate and host verified).
- `parsePostgresConnectionString` uses the standard `URL` class, decodes percent-encoding, strips IPv6 brackets, understands only `sslmode`, and ignores other query parameters.
- **No error message ever contains the input**, because messages go to the browser and possibly to logs. Tests assert this.

### Server side: `lib/server/parse-request.ts`

`parseJsonBody(request, schema)` runs checks in a fixed order and returns either `{ ok: true, data }` or `{ ok: false, response }`:

| Check                                                                                | Failure                                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `Content-Type: application/json`                                                     | 415 `unsupported_media_type`                              |
| Body at most 64 KB (streamed, so a missing or false Content-Length cannot bypass it) | 413 `payload_too_large`                                   |
| Valid JSON                                                                           | 400 `invalid_json`                                        |
| Matches the schema                                                                   | 400 `validation_error` with `issues: [{ path, message }]` |

Route handlers use it like this:

```text
const parsed = await parseJsonBody(request, schema);
if (!parsed.ok) return parsed.response;   // complete error response, nothing else to do
// parsed.data is typed AND verified
```

### The first validated endpoint

`POST /api/connections/validate` checks connection details and returns a password-free summary. It does **not** connect to anything (Phase 6 adds that).

### Browser side

- `features/connections/api.ts` is the only place that calls the API. It returns results instead of throwing, and verifies every response with the shared schemas.
- `connection-string-form.tsx` validates with the shared schema first, then asks the server. The connection-string input is masked (it usually holds a password) with a show/hide toggle.
- The backend-status hook now uses `healthResponseSchema` instead of a hand-written check.

## Phase 4: the database core (`packages/database-core`)

No real database is involved yet. This phase defines the vocabulary and the contract that every database provider must follow, and proves the contract can be implemented without any driver.

```text
packages/database-core/src/
├── models.ts            metadata types: SchemaInfo, TableInfo, ColumnInfo, ConstraintInfo,
│                        IndexInfo, RelationshipInfo, ...
├── errors.ts            DatabaseError, error codes, safe messages, describeDatabaseError()
├── adapter.ts           the DatabaseAdapter interface
├── registry.ts          AdapterRegistry: provider name -> adapter factory
├── index.ts             public entry point
└── testing/             separate entry point: @datacanvas/database-core/testing
    ├── ecommerce-fixture.ts   sample shop database (users, orders, products, order_items)
    ├── mock-adapter.ts        in-memory DatabaseAdapter
    └── index.ts
```

### Why this layer exists

```text
route handler / service  ──►  DatabaseAdapter (interface)  ◄──  MockDatabaseAdapter   (tests, UI demos)
                                       ▲                    ◄──  PostgresAdapter       (Phase 5, uses `pg`)
                                       │                    ◄──  (a future MySQL adapter)
                                database-core: no drivers, no Next.js, no dependencies
```

Higher layers depend on an **abstraction** (the interface), not on a concrete driver. That is dependency inversion. Swapping or adding a database means writing one new adapter and registering it; nothing above changes.

### The adapter contract

| Method                                                    | Purpose                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `connect()`                                               | Open and verify the connection. Idempotent.                                                 |
| `testConnection()`                                        | Verify the details work and keep nothing open. For the "Test connection" button.            |
| `getSchemas()`                                            | User-visible schemas.                                                                       |
| `getTables(schema)`                                       | Tables, views and materialized views in a schema.                                           |
| `getColumns / getConstraints / getIndexes(schema, table)` | Detail of one table.                                                                        |
| `getRelationships()`                                      | Every confirmed foreign key in the database (one call, because the canvas needs all edges). |
| `disconnect()`                                            | Release everything. Safe to repeat.                                                         |

Rules every implementation follows:

- It throws only `DatabaseError`; raw driver errors are translated by the adapter.
- Structure only; there is **no method that runs SQL or returns rows**.
- Unknown schema or table: `not_found`. Data call before `connect()` or after `disconnect()`: `not_connected`.
- Results are plain, JSON-safe data. "No value" is `null`, never `undefined`.

### Errors

`DatabaseError` carries a stable `code` (`authentication_failed`, `unreachable`, `ssl_error`, `timeout`, `permission_denied`, `database_not_found`, `not_found`, `not_connected`, `unexpected`) and a **safe, fixed message per code**. The original driver error is kept in `cause` for server-side debugging only and is not serialised (`toJSON` returns just `code` and `message`). `describeDatabaseError(anything)` is what route handlers use in `catch`: any non-`DatabaseError` collapses to `unexpected`, so driver details cannot leak.

### Relationships

`RelationshipInfo` represents a **confirmed foreign key** only. Cardinality is seen from the source table: `many-to-one` (normal FK) or `one-to-one` (the FK columns are also unique). Many-to-many appears as two links through a junction table. Inferred or user-drawn links belong to the workspace layer (Phases 7 and 8), never to adapter output.

### Registry

```text
const registry = new AdapterRegistry<{ postgresql: ResolvedPostgresConnection }>();
registry.register("postgresql", (config) => new PostgresAdapter(config));   // Phase 5/6
const adapter = registry.create("postgresql", details);                     // config type is checked
```

The registry is generic over a "config map", so each provider keeps its own precise connection-detail type while this package knows nothing about any provider. `create` builds an adapter without connecting.

### Testing support and architecture rules

- `MockDatabaseAdapter` implements the interface in memory. It can simulate failures (`failConnectWith`) and returns copies, so callers cannot corrupt its data. Its methods are `async` so errors are rejected promises, like a real adapter.
- `tests/architecture.test.ts` turns the independence rule into a test: `database-core` must declare no dependencies and may import only relative modules (plus `vitest` in test files). Adding `import "pg"` there makes the test fail.

## Phase 5: the PostgreSQL adapter (`packages/postgres-adapter`)

```text
packages/postgres-adapter/src/
├── connection/
│   ├── config.ts        DataCanvas connection details -> `pg` pool settings (SSL, timeouts, pool size)
│   ├── errors.ts        mapPgError(): anything `pg`/Node throws -> safe DatabaseError
│   └── read-only.ts     withReadOnlyTransaction(): every query runs in BEGIN READ ONLY + timeout
├── introspection/       one file per kind of metadata; each is a fixed, commented SQL query
│   ├── system-schemas.ts, schemas.ts, tables.ts, existence.ts
│   ├── columns.ts, constraints.ts, indexes.ts, relationships.ts
├── postgres.adapter.ts  PostgresAdapter implements DatabaseAdapter
└── index.ts
```

### How one method call travels

```text
adapter.getColumns("public", "orders")
  -> read(): is there a pool?                      no -> DatabaseError not_connected
  -> pool.connect()  ->  BEGIN READ ONLY  ->  set_config('statement_timeout', ..., local)
  -> assertRelationExists()                        no -> DatabaseError not_found
  -> COLUMNS_SQL with $1 = "public", $2 = "orders" (bound parameters, never string-built)
  -> map rows to ColumnInfo[]  ->  COMMIT  ->  release the connection to the pool
  -> any error on the way: ROLLBACK, then mapPgError() -> DatabaseError
```

### Where the metadata comes from

PostgreSQL describes itself in tables called **system catalogs** (schema `pg_catalog`). DataCanvas reads them directly.

| Catalog              | One row per                                             | Used for                                            |
| -------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `pg_namespace`       | schema                                                  | schema list, hiding `pg_*` and `information_schema` |
| `pg_class`           | table, view, index, sequence... (`relkind` tells which) | table list and kind                                 |
| `pg_attribute`       | column                                                  | columns, types (`format_type`), nullability         |
| `pg_attrdef`         | column default                                          | default expressions (`pg_get_expr`)                 |
| `pg_description`     | comment                                                 | table and column comments                           |
| `pg_constraint`      | constraint                                              | primary key, unique, foreign key, check             |
| `pg_index` + `pg_am` | index                                                   | indexes, key columns, uniqueness, access method     |

Columns are referenced by NUMBER (`conkey`, `indkey` hold `attnum` values), so queries join `pg_attribute` to turn numbers into names. `unnest(...) WITH ORDINALITY` keeps the original column order.

### Relationships

Only **declared foreign keys** (`pg_constraint` rows with `contype = 'f'`): referencing table and columns (`conrelid`/`conkey`), referenced table and columns (`confrelid`/`confkey`), `ON DELETE`/`ON UPDATE` actions (`confdeltype`/`confupdtype`). Names are never used to guess relationships.

Cardinality is computed in TypeScript (`deriveCardinality`, unit tested): a foreign key is **one-to-one** when some unique key of the source table consists only of columns that belong to the foreign key. Partial, expression and invalid unique indexes do not count, because they do not guarantee uniqueness of the whole column set.

### Safety properties

- Every query is a fixed string with bound parameters; identifiers and values from callers are never concatenated into SQL.
- Every operation runs in `BEGIN READ ONLY`, so the server itself rejects writes. A test proves an `INSERT` is refused.
- Every statement has a timeout (default 15 s); connecting has one (default 10 s); the pool holds at most 3 connections; idle connections are closed after 30 s.
- Only catalog metadata is read, never rows. Row counts come from the planner's statistics.
- TLS settings are always passed explicitly, so a `PGSSLMODE` environment variable cannot weaken them. `verify-full` verifies certificate and host name.
- Raw driver errors never leave the package: `mapPgError` maps them to codes with fixed messages and keeps the original only as `cause`.

### Testing strategy

| Layer                                                            | Needs a database               | What it proves                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests (`errors`, `config`, `relationships`, `tables`)       | no                             | error mapping table, SSL mapping, cardinality rules, row-estimate rules                                                                                                                                                       |
| Shared **contract suite** (`@datacanvas/database-core/contract`) | mock: no, PostgreSQL: yes      | the mock and the real adapter behave identically                                                                                                                                                                              |
| PostgreSQL integration tests                                     | yes (`DATACANVAS_TEST_PG_URL`) | real catalogs, partitions, expression/GIN/INCLUDE indexes, composite FKs, read-only enforcement, timeouts, connection hygiene, real error codes (wrong password, missing database, no TLS, no CONNECT privilege, closed port) |

Integration tests create a uniquely named database and role on a disposable server, load `examples/ecommerce.sql`, and drop both afterwards. They are skipped when the environment variable is absent, so `npm test` works anywhere.

## Phase 6: the first complete explorer

A user can connect to PostgreSQL and browse schemas, tables, columns, constraints, indexes and relationships without writing SQL.

### The whole path of "Connect"

```text
ConnectionForm (browser)
  1. validate with the shared Zod schema            -> field errors shown instantly
  2. createConnection(input)  ->  features/connections/api.ts
  3. apiRequest("POST /api/connections")            -> lib/api-client.ts (never throws)
        |
        v   HTTP, JSON body (contains the password, over loopback only)
app/api/connections/route.ts   POST
  4. parseJsonBody(request, postgresConnectionInputSchema)   -> 415 / 413 / 400 or typed data
  5. getServerContext().connections.createConnection(data)
        |
        v
ConnectionService.createConnection (lib/server/connection-service.ts)
  6. resolvePostgresConnection(data)               -> one normalised shape, SSL mode decided
  7. adapters.create("postgresql", resolved)       -> AdapterRegistry -> createPostgresAdapter
  8. adapter.connect()                             -> pool + SELECT 1 in a READ ONLY transaction
        |  failure: DatabaseError(code)            -> nothing stored
        v
ConnectionRegistry.add(summary, adapter)           -> opaque id; password stays INSIDE the adapter
        |
        v   response: 201 { connection: { id, name, host, ..., hasPassword } }   (no password)
store.addConnection(summary) -> sidebar and workspace re-render
```

Every failure on the way (any step 4 to 8) is converted by `handleRoute` into `{ error: { code, message } }` with a suitable HTTP status; the form shows the message.

### Server side (`apps/web/lib/server`)

| File                                  | Responsibility                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.ts`                          | Composition root. Builds the adapter registry, connection registry and service once, stored on `globalThis` so hot reload does not orphan open connections.                                    |
| `connection-registry.ts`              | In-memory map: opaque id to `{ summary, adapter }`. The ONLY place credentials live, in memory only. Limit of 10 connections. Idle sweeper.                                                    |
| `connection-service.ts`               | Application logic: test, create, list, delete, and the read operations. Knows only the `DatabaseAdapter` interface. Receives its collaborators through the constructor (dependency injection). |
| `error-response.ts`                   | `handleRoute` and `toErrorResponse`: any thrown value becomes the standard error response; logs only names and codes.                                                                          |
| `route-support.ts`                    | `jsonResponse` (no-store), `parseQuery` (Zod for query strings), the `RouteParams` type.                                                                                                       |
| `parse-request.ts`, `api-response.ts` | From Phase 3.                                                                                                                                                                                  |

Route handlers are about 15 lines each: validate, call a service method, return JSON.

### API

| Method and path                                  | Purpose                         | Success                             |
| ------------------------------------------------ | ------------------------------- | ----------------------------------- |
| `GET /api/connections`                           | list connections                | 200 `{ connections }`               |
| `POST /api/connections`                          | connect and remember            | 201 `{ connection }`                |
| `POST /api/connections/test`                     | check details, remember nothing | 200 `{ ok: true }`                  |
| `DELETE /api/connections/:id`                    | disconnect, forget credentials  | 200 `{ ok: true }`                  |
| `GET /api/connections/:id/schemas`               | schemas                         | `{ schemas }`                       |
| `GET /api/connections/:id/tables?schema=`        | tables, views, matviews         | `{ tables }`                        |
| `GET /api/connections/:id/tables/:table?schema=` | columns, constraints, indexes   | `{ columns, constraints, indexes }` |
| `GET /api/connections/:id/relationships`         | all foreign keys                | `{ relationships }`                 |

Failures use `{ error: { code, message, issues? } }`:

| Status    | Codes                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| 400       | `validation_error`, `invalid_json`, `authentication_failed`, `database_not_found`, `ssl_error`, `permission_denied` |
| 404       | `connection_not_found`, `not_found` (missing schema or table)                                                       |
| 409       | `connection_limit_reached`, `not_connected`                                                                         |
| 413 / 415 | `payload_too_large` / `unsupported_media_type`                                                                      |
| 502 / 504 | `unreachable` / `timeout`                                                                                           |
| 500       | `unexpected`                                                                                                        |

### Secrecy rules and how they are enforced

- The browser only ever receives `ConnectionSummary` (no password, `hasPassword: true/false`). A schema without a password field strips even an accidentally included one.
- The route tests send a distinctive password through every endpoint, including failing ones, and assert it appears in **no** response.
- Error logs contain only error names and codes, never messages (a test checks this).
- The browser keeps passwords only in form state until submit; nothing is stored in the store, `localStorage` or the URL.

### Idle handling

After 30 minutes without use, the idle sweeper (every 60 s) closes a connection's database sessions but keeps its registry entry, so the next request reconnects transparently. A request in progress is never interrupted (`inFlight` counter). `DELETE` is the only way credentials are discarded (besides stopping DataCanvas).

### Client side

| File                        | Responsibility                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `lib/api-client.ts`         | `apiRequest(path, schema, options)`: never throws; returns verified data or `{ code, message, issues }`.          |
| `lib/use-async-data.ts`     | `useAsyncData(load, key)`: loading / error / success state, reload, and ignores stale responses.                  |
| `stores/workspace-store.ts` | Zustand: connection summaries, selected connection and table, dialog state. The server stays the source of truth. |
| `features/connections/*`    | API functions, the form (string or fields tab, Test and Connect), the dialog, the sidebar list.                   |
| `features/explorer/*`       | Schema tree (lazy table loading), table details panel, workspace switcher.                                        |

Refreshing the page keeps the connections: the browser asks `GET /api/connections` on load, and the server still holds them.

### Packaging fix found during this phase

Turbopack refers to `pg` by a hashed alias (`pg-587764f78a6c7a9c`) provided as a symlink in `.next/node_modules`. `npm pack` drops symlinks, so the packed app could not load `pg`. `scripts/build-package.mjs` now replaces each such symlink with a real shim package that re-exports the real one.

## Phase 7: the interactive canvas

Tables become draggable cards on an infinite, zoomable plane; foreign keys are drawn as edges between them.

### The pieces

```text
packages/canvas-engine/        pure logic: no React, no canvas library (enforced by tests/architecture.test.ts)
├── constants.ts               node width 280, header 40, row 26, footer 30, gaps, collapse limit 12
├── ids.ts                     node ids (= tableRefKey) and handle ids
├── columns.ts                 visibleColumns, hiddenColumnCount, estimateNodeHeight
├── layout.ts                  gridLayout (square-ish grid), nextFreePosition (one new node)
├── edges.ts                   buildEdges(relationships, tablesOnCanvas) -> edge descriptors
└── search.ts                  searchTables (ranks table-name matches first)

apps/web/
├── stores/metadata-store.ts   CACHE of database structure per connection (tables, columns, relationships)
├── stores/canvas-store.ts     LAYOUT per connection: which tables, where, expanded, selected
├── features/canvas/
│   ├── add-tables.ts          workflow: fetch structure (bulk), then create nodes
│   ├── canvas-view.tsx        React Flow canvas: viewport, minimap, grid, toolbar, fit/focus effects
│   ├── table-node.tsx         the custom node that draws one table
│   ├── use-canvas-edges.ts    derives edges from relationships + tables present
│   └── canvas-toolbar.tsx     search, reset layout, grid, select all, remove
└── features/explorer/         sidebar tree: click adds a table; grid button adds a whole schema
```

### How the state is organised

|          | Metadata store                     | Canvas store                                                                |
| -------- | ---------------------------------- | --------------------------------------------------------------------------- |
| Holds    | what the DATABASE looks like       | what the USER arranged                                                      |
| Per node | full columns, constraints, indexes | `{ id, position, data: { schema, name, expanded, columnCount }, selected }` |
| Source   | server (re-fetchable)              | the user (what a saved workspace will contain in Phase 8)                   |

A **node** is a React Flow `Node` object: an `id`, a `position` in canvas space, a `type` ("table") and `data`. Its `id` is `tableRefKey({schema, name})`, the same key the metadata store uses, so a node finds its columns with one lookup. The node holds only identity; **columns are read from the metadata store**, so there is one copy.

**Edges are never stored.** `buildEdges` is a pure function of (relationships, tables present): add or remove a table and the right edges appear or vanish with nothing to synchronise. An edge references nodes by id (`source` and `target`) and attaches to a **handle** on each: the column's row (`source:column:user_id`, `target:column:id`) or, if that row is hidden by collapsing, the table header (`source:table`). Handles are the small connection points inside each node.

### Coordinates, zoom and pan

Every node's `position` is in **canvas space**: a large plane that does not move when you pan or zoom. The viewport is a window onto that plane:

```text
screen = canvas * zoom + pan          (the React Flow viewport is { x: panX, y: panY, zoom })
```

Panning changes `pan`; zooming changes `zoom` (around the cursor); neither changes any node. Dragging a node changes its canvas position by `mouseMovement / zoom`, so a node follows the cursor at any zoom level. React Flow keeps the viewport internally and reports node changes as `NodeChange` objects (`position`, `select`, `dimensions`, `remove`); `applyNodeChanges` folds them into the node list in our store. The viewport is not stored yet (Phase 8).

### From a click to a card on the canvas

```text
click "orders" in the tree (canvas view)
  -> addTablesToCanvas(connectionId, [orders], { focus: true })
       1. metadataStore.ensureTables   -> POST /api/connections/:id/table-details (one request, only missing tables)
          metadataStore.ensureRelationships -> GET .../relationships (once per connection)
       2. canvasStore.addTables([{ ref, columnCount }]) -> position chosen, node created
       3. canvasStore.requestFocus(node)
  -> canvas view re-renders: nodes changed -> edges re-derived -> React Flow draws the node
  -> once the node is MEASURED (useNodesInitialized) the view pans and zooms to it
```

Layout runs before a node has ever been drawn, so it uses **estimated** heights from `canvas-engine/constants` (header + rows + footer). `table-node.tsx` uses the same numbers. If they drift apart, nodes overlap or leave gaps.

### Bulk structure loading

The canvas needs many tables at once, so `DatabaseAdapter.getTablesDetails(tables)` returns description, columns, constraints and indexes for any number of tables with **four queries** (descriptions, columns, constraints, indexes). The wanted tables are passed as two text arrays and turned into a small table with `unnest($1::text[], $2::text[])`, then joined: still fully parameterised, one pass over the catalogs. The per-table methods (`getColumns` and friends) now call the same queries with a list of one, so there is one implementation of each query. A unit test proves the query count is 4 for 1 table and for 200.

### Performance measures

- `onlyRenderVisibleElements`: only nodes and edges on screen are drawn (6 nodes at start zoom out of 120).
- Table nodes are `memo`ised and read their own slice of the metadata store.
- While dragging, edges are NOT recomputed: `useCanvasEdges` selects small string arrays with `useShallow`, so their identity only changes when tables are added, removed or expanded.
- Collapsed tables show at most 12 columns.
- Adding a whole schema is capped at 200 tables.

## Phase 8: saving and restoring workspaces

Layouts and connection details now survive closing DataCanvas, even if it restarts on a different port.

### What is saved, and where

```text
~/.datacanvas/                       (DATACANVAS_HOME overrides; created owner-only, files mode 0600)
├── connections.json                 saved connection profiles   { format, schemaVersion, profiles: [...] }
└── workspaces/<id>.json             one file per layout         { format, schemaVersion, id, name, ..., canvas }
```

|             | Saved connection profile                   | Workspace                                                                 |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Holds       | name, host, port, database, user, SSL mode | table names, positions, expanded flags, pan and zoom, a display-only hint |
| Never holds | **the password**                           | credentials, columns/types (they would go stale), selection               |
| Lives for   | until the user forgets it                  | until deleted                                                             |
| Linked by   | `profileId` on a live connection           | `profileId` on the workspace                                              |

Why files and not IndexedDB: IndexedDB belongs to a browser origin including its port, so starting on 4748 instead of 4747 would silently hide everything. Files in the home folder do not depend on the port.

### How React Flow state becomes JSON and comes back

```text
SAVE   canvas store nodes (React Flow Node objects)          serializeCanvas()
         { id, type, position:{x,y}, data:{schema,name,expanded,columnCount,missing},
           selected, measured, dragging, ... }
       -> keep only:  { schema, name, x, y, expanded }  (positions rounded to 0.1)  + viewport {x,y,zoom}
       -> PUT /api/workspaces/:id  (body validated with Zod)
       -> server stamps id/timestamps -> JSON.stringify -> writeFileAtomic()

LOAD   GET /api/workspaces/:id -> parseWorkspaceFile(): migrate to current version, then validate (Zod)
       -> restoreWorkspace(): list each schema once, load structure of tables that exist (one bulk request)
       -> canvasStore.restore(nodes, viewport): nodes get their saved positions; tables that no longer
          exist are kept but flagged `missing`
       -> React Flow draws; the saved viewport is applied with setViewport
```

The saved document contains no selection, measurements or metadata: those are recomputed. Edges are not saved either: they are derived again from the relationships.

### Atomic writes

`writeFileAtomic` writes the complete new content to a temporary file in the SAME folder (`.name.<random>.tmp`, created exclusively with mode 0600), flushes it to disk (`fsync`), then `rename`s it over the real file. A rename is one operation, so a reader or a later run sees the whole old file or the whole new one, never half. A test hammers one file with 40 concurrent writers while a reader parses continuously: every read is complete JSON. A failed write removes its temporary file and leaves the original intact. `KeyedMutex` serialises read-modify-write sequences per file so two requests cannot overwrite each other's change.

### Versioned formats and migrations

Every file has `format` and `schemaVersion`. `migrateToCurrent` upgrades by running `migrations[n]` (version n to n+1) in order, THEN validates against the current schema, so the rest of the code only ever sees one layout. A file from a NEWER release is refused with a clear message instead of being guessed at. A test uses a pretend three-version format to prove the chain (rename a field at v1 to v2, add a field at v2 to v3) works before a real version 2 exists.

What happens when the workspace format changes in a future release (say v2 renames `expanded` to `collapsed`): bump `CURRENT_WORKSPACE_VERSION` to 2, add `WORKSPACE_MIGRATIONS[1] = (data) => ...` that rewrites each node, change `savedNodeSchema`, and add a test with a real v1 file. Old files open automatically and are written back as v2 on the next save. Files from v3 open in neither (refused).

### API additions

| Method and path                                        | Purpose                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `GET /api/profiles`                                    | saved connection profiles                                                             |
| `DELETE /api/profiles/:id`                             | forget it AND delete its workspaces (live connections opened from it are unlinked)    |
| `POST /api/connections` with `remember` or `profileId` | save a new profile / reconnect an existing one (password still required, never saved) |
| `POST /api/connections/:id/save`                       | save a live connection as a profile afterwards                                        |
| `GET /api/workspaces[?profileId=]`                     | summaries, newest first                                                               |
| `GET / PUT / DELETE /api/workspaces/:id`               | read, create or update (client chooses the id, server stamps times), delete           |
| `GET /api/workspaces/:id/export`                       | download `<name>.datacanvas.json` (machine-specific profile link removed)             |
| `POST /api/workspaces/import[?profileId=]`             | upgrade, validate, save as a NEW workspace                                            |

### Autosave

`createAutosaver` listens to the canvas store. Each change restarts an 800 ms timer (debounce), so a drag is one save. Before writing it builds the document that would be saved and compares a signature with the last saved one, so selecting or measuring never writes. One save per connection runs at a time; a change during a save triggers a follow-up. The first save of a layout creates the workspace; later saves update it; a rename is part of the document. It only runs for connections linked to a saved profile (the file must be findable after a restart); for others the bar says the layout is not saved and offers "Save connection". Switching or creating a workspace flushes the current one first.

### Stale layouts

A saved layout names tables, but the database may have changed. Restoring lists each referenced schema once (not one request per table). Tables that are gone become dashed "no longer exists" cards at their saved positions, are saved again with the layout, and a banner says how many. A missing schema counts as missing tables; any other failure (unreachable, timeout) aborts the restore and leaves the canvas as it was.

### Safety summary

- An id becomes a file name in exactly one place; the id pattern allows no path characters, and tests try `../../etc/passwd`, `..`, `a/b`, NUL, over-long and empty ids on every storage operation: nothing is read, written or created outside the workspaces folder.
- Damaged files: a workspace file is skipped when listing (never deleted); `connections.json` is moved aside and a fresh one started; a file from a newer release is refused untouched.
- Error messages never include paths, file content or the system's message (a test checks the path is absent).
- Limits: 2000 nodes per workspace, 1 MB per request, 500 workspaces, 100 profiles, coordinates within +-10 million, zoom 0.01 to 10.

## Phase 9: exploring large schemas

Phase 9 adds the tools that keep a big schema usable: search, filters, focus mode, automatic layouts, an inspector panel and image export.

**Pure logic lives in `canvas-engine`** (no React, no I/O, easy to test):

- `graph.ts` builds the relationship graph from edges and answers questions on it: `reachableWithin` (breadth-first search, N hops, direction-aware), `shortestPath`, `connectedComponents`.
- `filters.ts` decides which nodes and edges are visible (schemas, views, relationship types).
- `pack.ts` (`shelfPack`) places several groups of tables side by side without overlap.
- `ids.ts` gained `parseNodeId`, the inverse of `nodeIdFor`.

**Search is split in two.** Tables already on the canvas are matched instantly in the browser. Everything else is asked of the server: `DatabaseAdapter.searchObjects(query, limit)` is part of the adapter interface (and the shared contract tests), the PostgreSQL version runs two parameterized catalog queries (tables, columns), and `GET /api/connections/:id/search?q=&limit=` exposes it (query 1-100 characters, at most 50 results). `%` and `_` are matched literally.

**View state is separate from layout state.** `canvas-view-store` keeps filters, focus mode (off, dim, hide), hop count, direction and inspector visibility per connection. It is not saved with a workspace. `features/canvas/display.ts` (`computeDisplay`) turns nodes, edges, selection and view state into hidden ids, dimmed ids and dimmed edges. `useCanvasDisplay` subscribes with shallow selectors so dragging a node does not recompute edges.

**Automatic layouts** (`elk-layout.ts`) load ELK on demand (dynamic import, so it is not in the first page load): hierarchical (layered), compact (rectpacking) and grouped (a layered layout per connected component, then `shelfPack`).

**Inspector and export.** `inspector-panel.tsx` reads the selected table from the metadata cache (no extra request). `export-image.ts` renders the canvas with html-to-image to PNG or SVG; the dialog warns that the image shows table and column names.

## Phase 9: what is not covered

Verified in the in-app browser against PostgreSQL only; no other browsers or PostgreSQL versions. SVG export shares the PNG code path but was not exercised separately.

## Phase 10: security hardening

The local server is protected in layers. All rules live in one pure module, `apps/web/lib/security/request-guard.ts`, so the same code runs in two places:

1. **`apps/web/proxy.ts`** (the Next.js 16 name for middleware) runs before every page and route. It also performs the one-time token exchange: the first URL printed by the CLI is `/?token=...`; if the token matches, the proxy sets an `HttpOnly`, `SameSite=Strict` cookie named `dc_session_<port>` and redirects to the same URL without the token.
2. **`handleRoute(request, work)`** repeats the checks inside every API route (`/api/health` calls `guardRequest` directly). If the proxy were bypassed or misconfigured, no route could still run unguarded. `tests/security.test.ts` fails if a route forgets this.

Rules, in order: Host must be `127.0.0.1:<port>` or `localhost:<port>`; for `/api/*` the browser's `Sec-Fetch-Site` must be `same-origin` or `none`; state-changing requests that carry an `Origin` must come from our own origin; the session cookie must match the per-run token (constant-time comparison). `/api/health` is the only path without the token (the CLI polls it). In production a missing token means **refuse everything** (503), never "run open".

The CLI (`packages/cli/src/web-server.ts`) creates a fresh 32-byte token each run, passes it to the server through the environment, switches framework telemetry off, and prints the tokenized link. `next.config.ts` adds response headers: no framing, no sniffing, no referrer, same-origin resource and opener policies. No CORS headers are sent anywhere.

Documents: `SECURITY.md` (for users), `docs/threat-model.md` (assets, attackers, residual risks). CI (`.github/workflows/ci.yml`) runs the full check and `npm audit --omit=dev`.

## Phase 10: what is not covered

Verified in one browser on one machine. No independent review. No full Content-Security-Policy. No defence against a program running as the same user.
