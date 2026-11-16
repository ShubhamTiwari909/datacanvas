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
├── errors.ts            DatabaseError, error codes, safe messages
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

| Method                                                    | Purpose                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect()`                                               | Open and verify the connection. Idempotent.                                                                                                                   |
| `testConnection()`                                        | Verify the details work and keep nothing open. For the "Test connection" button.                                                                              |
| `getSchemas()`                                            | User-visible schemas.                                                                                                                                         |
| `getTables(schema)`                                       | Tables, views and materialized views in a schema.                                                                                                             |
| `getColumns / getConstraints / getIndexes(schema, table)` | Detail of one table.                                                                                                                                          |
| `getRelationships()`                                      | Every confirmed foreign key in the database (one call, because the canvas needs all edges).                                                                   |
| `getIndexUsage()`                                         | How often each index of the ordinary tables has been used (the server's statistics counters), when they were last reset, and whether the server is a standby. |
| `getRows(table, options)`                                 | One bounded page of a table's ROWS, as text (the only method that returns data; used only by the opt-in data viewer, not yet exposed by any route).           |
| `getObjects()`                                            | Views (with definitions and what they read), types, sequences, functions, triggers, extensions and row-level-security policies, in one call.                  |
| `disconnect()`                                            | Release everything. Safe to repeat.                                                                                                                           |

Rules every implementation follows:

- It throws only `DatabaseError`; raw driver errors are translated by the adapter.
- Almost every method returns structure. The one exception is `getRows`, the opt-in data viewer (see "Reading table rows" below), which the service layer calls only for a connection with data access switched on. There is **no method that runs SQL you wrote**.
- Unknown schema or table: `not_found`. Data call before `connect()` or after `disconnect()`: `not_connected`.
- Results are plain, JSON-safe data. "No value" is `null`, never `undefined`.

### Errors

`DatabaseError` carries a stable `code` (`authentication_failed`, `unreachable`, `ssl_error`, `timeout`, `permission_denied`, `database_not_found`, `not_found`, `not_connected`, `unexpected`) and a **safe, fixed message per code**. The original driver error is kept in `cause` for server-side debugging only and is not serialised (`toJSON` returns just `code` and `message`). Route handlers run inside `handleRoute` (`apps/web/lib/server/error-response.ts`), which turns any error that is not a `DatabaseError` or `ServiceError` into the generic `unexpected` response, so driver details cannot leak.

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
- Catalog metadata is read everywhere; rows are read only by `getRows`, behind the per-connection data-access check. Row counts shown in the explorer come from the planner's statistics, never from a scan.
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

- `graph.ts` builds the relationship graph from edges and answers questions on it: `reachableWithin` (breadth-first search, N hops, direction-aware) and `connectedComponents`. (Routes between two tables are found by the Paths tab's own search, see Path finder.)
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

## Phase 11: the command line and the one-command install

`npx --yes @shubhamtiwari909/datacanvas` runs `bin/datacanvas.mjs` (the CLI, bundled by esbuild into one file). In order:

1. **Node check** (20.9+) with an actionable message; flags via `util.parseArgs` (`--port`, `--no-open`, `--version`, `--help`, nothing else).
2. **Data folder** (`~/.datacanvas`, or `DATACANVAS_HOME`): created owner-only (mode 0700) on first run, with a one-line welcome. `cli/src/data-dir.ts` repeats the web app's resolver on purpose (the CLI is bundled alone); `tests/data-dir.test.ts` fails if they disagree.
3. **Already running?** `cli/src/instance.ts` reads `run.json` (port, token, pid; mode 0600). If that process is alive and `/api/health` answers as DataCanvas, the CLI opens the running instance's private link and exits. Stale files (crash) are ignored.
4. **Port:** 4747, or the next free one (with a message); an explicit `--port` must be free.
5. **Start** `web/apps/web/server.js` as a child process on `127.0.0.1` with a fresh token, wait for `/api/health`, write `run.json`, print the link, open the browser (`open`, `start`, `xdg-open`; the link is printed anyway).
6. **Shutdown** (Ctrl+C / SIGTERM): the CLI signals the server, which (via `instrumentation.ts` and `lib/server/shutdown.ts`) closes every database session and forgets all credentials within 3 s, then exits; the CLI removes `run.json`. The CLI sets `NEXT_MANUAL_SIG_HANDLE=1` so Next.js does not exit first.

**Packaging:** `npm run package` assembles `.package/` (CLI + standalone web output + bundled `node_modules`, `files` allowlist, `engines.node`, no install scripts, no native add-ons). `npm run verify:package` then tests the PACKED tarball: it runs `npm pack`, installs the tarball into an empty project, and exercises the installed command (22 checks, including token protection, instance reuse and clean shutdown). It prints the tarball size and cold-start time.

## Phase 11: what is not covered

Verified on macOS only (no Windows or Linux run, no real `npx` from the registry because nothing is published). Two simultaneous first launches can race. A `kill -9` of the CLI leaves the server running until it is stopped by hand.

## Phase 12: testing and QA

Four layers, from fast to slow:

1. **Unit tests (Vitest)**: pure logic, schemas, the request guard, workspace migration, the CLI helpers.
2. **Integration tests (Vitest)**: the PostgreSQL adapter and the services against a real, disposable PostgreSQL (`DATACANVAS_TEST_PG_URL`; skipped without it), plus a performance test on a 600-table schema (`postgres.adapter.performance.test.ts`).
3. **Rule tests** (`tests/`): architecture and security rules that fail when someone breaks them quietly.
4. **End-to-end (Playwright, `e2e/`)**: a real Chromium against the real packaged app. `e2e/fixtures.ts` starts `.package/bin/datacanvas.mjs` on a free port with a private data folder and a throwaway database. Specs: `core-flow` (connect, browse, canvas, drag a node, autosave, reload, disconnect, reconnect, layout restored), `install-qa` (wrong password, unreachable database, TLS mismatch, port in use), `performance` (400 tables). Run with `npm run package && npm run test:e2e`.

`npm run verify:package` is the install test: it packs, installs the tarball into an empty project and drives the installed command (22 checks).

`.github/workflows/ci.yml` runs everything on Linux and the install check on macOS, Linux and Windows with two Node versions.

## Phase 12: what is not covered

The CI file has never run on GitHub. Nothing was run on Windows or Linux, or in Firefox or WebKit. The end-to-end tests drive `.package/` (the assembled package), not a tarball install (`verify:package` covers that). No test runs the unsupported-Node message on a real old Node; only the version check is unit tested.

## Phase 13: release preparation

Everything that can be prepared without the maintainer's accounts is in place:

- **User docs:** README (one-line install on the first screen, screenshots in `docs/images/` made by `npm run screenshots`), `docs/getting-started.md`, `SECURITY.md`, `CHANGELOG.md`, issue and pull-request templates.
- **Release gate:** `npm run release:check` (`scripts/release-check.mjs`) inspects the assembled package and the repository and lists every blocker: placeholder version, missing license, repository or security contact, missing changelog section. It reports, and never fills in, decisions that belong to the maintainer.
- **Metadata:** `scripts/build-package.mjs` copies `license`, `author`, `repository`, `homepage` and `bugs` from the root `package.json` into the published package; it never invents them.
- **Release workflow:** `.github/workflows/release.yml` runs on a pushed `v*` tag, repeats the whole check, requires `release:check` to pass and the tag to match the version, then publishes with npm provenance through trusted publishing (no stored token).
- **Releasing:** `docs/releasing.md` lists the steps, the accounts and what is still open.

## Phase 13: what is not covered

Nothing has been published or pushed. There is no LICENSE, no repository address and no security contact, so `release:check` fails on purpose. The release and CI workflows have never run. No demo GIF.

## Robustness: awkward schemas and PostgreSQL versions

`examples/odd-schema.sql` is a deliberately awkward database: names with spaces, capitals, accents, quotes, dots, emoji and SQL-looking text; the 63-byte name limit; the same table name in two schemas; enums, domains, composite types, arrays, ranges and generated columns; tables with no columns, no key, or 301 columns; composite, self-referencing, circular, deferrable and cross-schema foreign keys; inheritance; nested list/range/hash partitions with a foreign key to a partitioned parent; views of views and materialized views; expression, partial, covering, GIN and BRIN indexes; temporary and unlogged tables.

`postgres.adapter.odd-schema.test.ts` loads it into a throwaway database and pins down what the adapter returns for each case (31 tests). `scripts/pg-matrix.mjs` (`npm run test:pg-matrix`) runs all PostgreSQL-facing tests against PostgreSQL 12 to 18, one Docker container per version; CI does the same with a job matrix.

**Result on PostgreSQL 17:** no adapter bug was found in these cases. One gap was confirmed, foreign tables (for example `postgres_fdw`) being hidden; it is now fixed (decision 93).

## Schema overview

A third tab next to Canvas and Table details. `features/overview/`:

- `schema-overview.ts`: pure functions (`computeSchemaOverview`, `computeDatabaseOverview`, `relationshipDegrees`) that turn the table lists and the foreign keys into per-schema numbers: counts by kind, summed row estimates, relationships inside / going out / coming in, connected schemas, the five most connected tables, tables with no relationship, the five largest.
- `load-overview.ts`: reads the schema list, one table list per schema (in parallel) and the foreign keys. The foreign keys go through the same metadata cache the canvas uses, so they are fetched once per connection.
- `schema-overview-view.tsx`: the cards. A table name is a button that puts the table on the canvas and switches to it; "Add to canvas" adds a whole schema (with the existing 200-table cap).

No new endpoint and no new database query: it only combines data the app already reads. A table counts as having no relationships only when no _declared_ foreign key touches it; views never have foreign keys, so they are not listed as such. Covered by 16 unit tests and an end-to-end test (`e2e/overview.spec.ts`), and checked by eye against the awkward schema.

## Health checks

A fourth tab, `features/health/`:

- `health-checks.ts`: pure `runHealthChecks(entries, relationships)` over the details of every table. Checks: no primary key; foreign key without a supporting index (an index whose leading columns, in any order, equal the foreign key's; partial indexes and index types that cannot serve equality lookups do not count; downgraded to a note for tables under 1000 estimated rows); duplicate indexes (same method, uniqueness, key columns, predicate and INCLUDE); redundant prefix indexes; nullable foreign key columns; tables over 50 columns. Index key names are un-quoted before comparing because PostgreSQL prints `"select"` quoted while constraints give the raw name.
- `load-health.ts`: lists every schema's tables (shared `explorer/load-all-tables.ts`), loads their details through the metadata cache in bulk (at most 2000 tables) and runs the checks.
- `health-view.tsx`: findings grouped by check with the reason, the fix, a button per table that shows it on the canvas, and SQL to copy. Warnings are open, notes are folded.

Metadata only; suggested SQL is shown, never executed. Unit tests and end-to-end tests (`e2e/health.spec.ts`) that plant problems in a throwaway database and check exactly those are reported.

### Three more checks: unused indexes, type mismatches, naming

- **Unused indexes** (`unused_index`). The only check that needs more than the structure: `getIndexUsage()` reads `pg_stat_all_indexes.idx_scan` (a counter the server keeps about itself; no table rows), the index size, whether a constraint owns the index, the time of the last statistics reset (`pg_stat_database.stats_reset`) and `pg_is_in_recovery()`. The check is cautious on purpose because "zero scans" is easy to over-read: it never lists an index that backs a primary key, unique or exclusion constraint (`pg_constraint.conindid`), a unique index, or an invalid one; it is a warning only when the index is at least 10 MB, the counters are at least a week old (or of unknown age) and the server is not a standby, otherwise information (a standby's counters only cover its own queries, so the finding says so); when the index is the only one serving a foreign key it says so and offers no `DROP`, because deleting from the parent would then scan the child; and the tab states when the counters start and, on a standby, that they only reflect queries run there. The suggestion is `DROP INDEX CONCURRENTLY`. Partitions' indexes are not read (the partitioned table is the unit). If the counters cannot be read the other checks still run and the tab says why this one did not.
- **Type mismatches** (`type_mismatch`). For every foreign key column and the column it references, built-in types only (`BUILTIN_TYPES`): different types (integer and bigint, integer and text, an array and its element) are a warning with an `ALTER ... TYPE` to copy; a difference only in length or precision, or text against varchar, is information. A domain, an enum or an extension's type looks different from its base type without being a mistake, so a pair involving one is not judged. Composite keys are compared column by column, by position.
- **Naming** (`inconsistent_naming`, `fk_column_naming`). DataCanvas does not impose a convention, so both are judged against the database's own: names that need quoting (anything outside lowercase letters, digits and underscores) are reported only when at least 80% of the table and column names are plain (and there are at least ten); a single-column foreign key whose column does not end in `_id` is reported only when at least 80% of them do (and there are at least five). A database that uses capitals throughout is therefore not flagged at all.

Tests: the three checks (boundaries, composite keys, awkward names, the foreign-key and constraint exceptions, counters of unknown age), the SQL against a real PostgreSQL including a real counter going up (`postgres.adapter.index-usage.test.ts`), the route, and an end-to-end test. **Not covered:** plural against singular table names, naming of indexes and constraints, bloat and table statistics, unused tables, and index usage across several servers (replicas must be checked separately).

## Path finder

A fifth tab, `features/paths/`:

- `path-finder.ts`: `findPaths(relationships, from, to)` runs a breadth-first search over declared foreign keys in both directions (a self-reference leads nowhere and is skipped), keeps every shortest parent edge, and rebuilds up to five equally short routes in a stable order (several foreign keys between the same two tables count as different routes). Each step records its direction: from a child to its parent returns at most one row, from a parent to its children can return many, which the view says. `buildJoinSql(route)` writes `SELECT * FROM … AS t1 JOIN … AS t2 ON … LIMIT 100;` with every name quoted (`lib/sql-text.ts`) and composite keys joined on every column pair.
- `load-path-data.ts`: every table (views have no keys) plus the foreign keys from the shared metadata cache.
- `path-view.tsx`: two selects with a swap button, the route cards (chain, columns, SQL with Copy, Show on canvas) and the empty, same-table and no-route states.

17 unit tests (including a graph with 6^8 equally short routes, which returns in under a second), an integration test that executes the generated SQL for every connected pair of tables in the sample shop and the awkward schema on a real PostgreSQL (56 routes), and an end-to-end test (`e2e/paths.spec.ts`).

## Foreign tables

`RelationKind` has a fourth value, `foreign_table` (model, shared Zod schemas, `LISTED_RELKINDS` with `relkind = 'f'`). Because tables, search and the existence check all use that one list, adding the kind there made foreign tables appear everywhere in the adapter. In the app, `components/relation-kind.ts` is the single place that names and draws each kind (`Record<RelationKind, ...>` maps, so a missing kind is a compile error); the schema tree, canvas node, inspector, search and table details all import it. The overview counts foreign tables separately. Health checks and the path finder look only at ordinary tables, which is correct: a foreign table has no keys or indexes here. Tested by adapter integration tests against a real `postgres_fdw` table (listing, kind, unknown estimate, columns and details, search) and an end-to-end test (`e2e/foreign-tables.spec.ts`).

## Theme (light, dark, system)

The palette was already there (shadcn's `:root` and `.dark` CSS variables) and no component hard-codes a color, so dark mode needed only the switching logic. `lib/theme.ts` holds the pure parts (choices, resolving "system", safe `localStorage` access, applying the `dark` class and native `color-scheme` to `<html>`) and `NO_FLASH_SCRIPT`, a fixed inline script placed in `<head>` by `app/layout.tsx`: it applies the saved theme before the first paint, so there is no white flash while React loads (`<html suppressHydrationWarning>` because it changes the class on purpose). `stores/theme-store.ts` keeps the chosen `preference` and the `resolved` theme and follows the operating system while the choice is System. `components/layout/theme-toggle.tsx` is the header button. The canvas passes `resolved` to React Flow's `colorMode`, and the image export takes its background from the page, so a dark export is dark. Tests: 9 unit tests (including running the inline script against stand-ins and comparing it with the pure functions) and `e2e/theme.spec.ts`, whose no-flash test blocks every app script so that only the inline script can set the class.

## Connection strings (host in the query, sockets)

`parsePostgresConnectionString` (in `packages/shared-types`) accepts `host` and `port` as query parameters, the way libpq writes them, so `postgresql://user:pw@/db?host=10.1.2.3` works. The standard URL parser rejects credentials followed by an empty host, so that case is rewritten to a reserved stand-in host (`.invalid`) before parsing and turned back into "no host" afterwards. A host that is a file path, in the address or in `?host=` (Cloud SQL's `/cloudsql/...`, Prisma's `localhost` plus `?host=/cloudsql/...`, a socket directory), is refused with one fixed explanation (`SOCKET_HOST_MESSAGE`), also when typed into the Host field. A host or port given twice that disagrees, several hosts, and a missing host each get their own message. No message ever contains any part of the input, because it holds the password. Covered by unit tests for each shape and by end-to-end tests (a socket string is explained in the form; a `?host=` string connects to a real database).

## Schema snapshots and diff

A **snapshot** is a copy of a database's structure at one moment, so it can be compared later. `packages/database-core/src/structure.ts` defines `DatabaseStructure` (schemas, tables with their columns, constraints and indexes, and the foreign keys) and `buildStructure`, which sorts everything so the same database always produces the same value. It deliberately leaves out the planner's row estimates (they change with every vacuum and would make an unchanged database look different) and never contains rows.

`packages/database-core/src/diff.ts` holds the pure comparison, `diffStructures(before, after)`. Tables are matched by `schema.name`, columns, constraints and indexes by name, and foreign keys by (source table, constraint name); foreign keys are compared once, as relationships, not again as constraints. Column position is ignored (dropping an early column renumbers the others, which is not a change to them). There is **no rename detection**: a rename is one removal and one addition. A changed item lists exactly which fields changed as readable text, so no screen needs to know the shape of each kind of item. `diffToMarkdown` writes the same result as a report.

Because the diff is pure and the app already bundles `database-core` for the browser, it runs in the browser: the server only provides structures. Any two sides work (snapshot or live database, of any connection), so comparing two different databases needs no extra endpoint.

Server side: `ConnectionService.captureStructure` reads the schemas, the tables of each, their details in batches of at most 500 (the same limit the canvas uses) and the foreign keys; it refuses more than 5000 tables (`snapshot_too_large`). `SnapshotService` takes, lists, loads, deletes, exports and imports snapshots; the browser only says "snapshot this connection" and may give a name, so a snapshot is never taken from the browser's word. `SnapshotStorage` writes `snapshots/<id>.json` with the same rules as workspaces: owner-only permissions, atomic writes, ids that can never be a path, damaged files skipped and left alone. At most 100 snapshots are kept. The file format is versioned (`datacanvas-snapshot`, now version 2) and read through the same migration path as other files; the 1 to 2 migration sets `objects` to `null`, because a version 1 snapshot never recorded them; unknown keys are refused and every string and list has an upper bound, because an imported file is untrusted. An import always gets a new id.

| Method and path                       | Purpose                               | Success                      |
| ------------------------------------- | ------------------------------------- | ---------------------------- |
| `GET /api/connections/:id/structure`  | the live structure, nothing saved     | `{ structure }`              |
| `POST /api/connections/:id/snapshots` | take a snapshot (`{ name? }`)         | 201 `{ snapshot }` (summary) |
| `GET /api/snapshots`                  | summaries, newest first               | `{ snapshots }`              |
| `GET /api/snapshots/:id`              | the full snapshot                     | `{ snapshot }`               |
| `DELETE /api/snapshots/:id`           | delete                                | `{ ok: true }`               |
| `GET /api/snapshots/:id/export`       | download `.snapshot.json`             | file                         |
| `POST /api/snapshots/import`          | import file content as a new snapshot | 201 `{ snapshot }` (summary) |

A snapshot also holds the objects (below). The diff matches them by what identifies each kind (a function by schema, name and argument list, so overloads are separate; a trigger or policy by its table and name). `objects: null` means "not recorded" and is not the same as "none": if either side is `null` the objects are **not compared** and the screen and the Markdown report say so, instead of reporting every function as new.

Integrity details. The limit of 100 snapshots is checked and the file written under one lock (`SnapshotService.putIfRoom`), because the database read between a check and a write can be slow and parallel requests would otherwise all see room for one more; a test fires more saves than there is room for and counts the files. The schemas' table lists are read eight at a time, so a database with one schema per tenant does not send hundreds of queries at once. **A snapshot is not atomic:** the schemas, tables, details, foreign keys and objects are separate reads, so one taken while a migration runs can mix states; the Snapshots tab and the guide say so. (Reading everything in one repeatable-read transaction would need the adapter to expose one; it is not done.) The comparison works on the raw values, not their display text, so a column list `["a, b"]` is different from `["a", "b"]`; no value and an empty string are the same; two items with the same key are both kept (paired in order) instead of the later one silently replacing the first; and `SchemaDiff.objectsCompared` says whether objects were compared at all, because `isEmpty` alone cannot tell "nothing differs" from "objects were not looked at". `summary.schemas.changed` is always 0 (a schema is only added or removed).

New error codes: `snapshot_not_found` (404), `snapshot_limit_reached` (409), `snapshot_too_large` (413), `invalid_snapshot_file` (400).

In the app, `features/snapshots` has `api.ts`, `compare.ts` (fetch both sides, diff them), `diff-view.tsx` and `snapshots-view.tsx` (the **Snapshots** tab). Tests: the diff engine and the shared contract (unit), the service and every route (mock adapter, temporary data folder, including a check that no password appears in any response or file), and `compare.ts` with mocked calls. **Not covered:** rename detection, and comparing a snapshot with an older one in terms of column order (ignored on purpose).

## Database objects

`getObjects()` reads everything that is not a table, column, index or foreign key, in one call, with one catalog query per kind (`packages/postgres-adapter/src/introspection/objects.ts`, all inside the read-only transaction the adapter already opens). It reads definitions and settings only: no table rows and no sequence values.

| Kind                         | Source                                                                       | What is kept                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Views and materialized views | `pg_class` (relkind `v`, `m`), `pg_get_viewdef`                              | the query as the server prints it, the comment, and **what it reads**                                                                                 |
| What a view reads            | `pg_rewrite` and `pg_depend`                                                 | the tables and views its rewrite rule depends on, once each                                                                                           |
| Types                        | `pg_type` (enum, domain, range, and composite types made with `CREATE TYPE`) | enum labels in declared order, composite attributes, a domain's base type, default and rules, a range's bound type                                    |
| Sequences                    | `pg_sequence`, `pg_depend`                                                   | type, start, step, limits, cache, cycle, and the column that owns it (serial and identity). Numbers are kept as text; the current value is never read |
| Functions and procedures     | `pg_proc`, `pg_get_functiondef`                                              | argument list (tells overloads apart), result, language, volatility, security definer, comment and the full definition                                |
| Triggers                     | `pg_trigger`, `pg_get_triggerdef`                                            | timing, events, row or statement, the function it calls, enabled or disabled, definition                                                              |
| Extensions                   | `pg_extension`                                                               | name, version, schema, description                                                                                                                    |
| Row-level security           | `pg_policy`, `pg_class.relrowsecurity`                                       | each policy (command, permissive or restrictive, roles, `USING` and `WITH CHECK` as SQL text) and which tables have security on, forced or not        |

Rules shared by the queries, each pinned by a test against a real server: system schemas are hidden; objects that **belong to an extension** are skipped (`pg_depend` type `e`; for views, types, sequences, functions, triggers and policies), so installing `pgcrypto` or PostGIS does not add hundreds of functions the user did not write; functions the server made as part of something else (`pg_depend` type `i`, for example the constructors of a range type) are skipped, but sequences of identity columns, which have that same dependency, are kept; the row type every table has, array types and internal triggers (foreign-key enforcement) are not listed; a partitioned table's triggers are shown once, not once per partition. A procedure's argument list is written without the explicit `IN` that PostgreSQL 14 and newer print (`normalizeArguments`), because the list identifies the function and a snapshot from one version must compare cleanly with a database on another; this was found by running the matrix, where 13 failed. Written for PostgreSQL 12 and newer (no `tgparentid`, which is 13+). Definitions longer than 20,000 characters are cut, and the cut text ends with its full length and a fingerprint (a 53-bit hash) of the whole text, so two long definitions that differ only after the cut still compare as different; the cut never splits an emoji; every list is sorted by code unit so a snapshot only changes when the database does (`normalizeObjects` in database-core, used by the real adapter and the mock alike).

`GET /api/connections/:id/objects` returns them. In the app, the **Objects** tab (`features/objects`) has one tab per kind with a name filter. For a view it shows what it reads and which views read it (names are links that show the table on the canvas); for row-level security it groups policies per table and flags the two situations that are easy to miss: security **on** with no policies (non-exempt roles see no rows) and policies with security **off** (they do nothing). Lists show the first 100 and offer the rest. Snapshots store the objects (at most 10,000 of each kind), and the comparison shows them next to the table changes, with long definitions as before and after blocks.

Tests: the queries against a real PostgreSQL (`postgres.adapter.objects.test.ts`, run by `npm run test:pg-matrix`), the normal form, the diff, the file format and its bounds, the 1 to 2 upgrade, the service and the route (all with the mock adapter), the list helpers, and an end-to-end test (`e2e/objects.spec.ts`). **Not covered:** aggregates and window functions (no body of their own), event triggers, rules, publications and subscriptions, foreign data wrappers and servers, collations, operators, casts, roles and grants, `COMMENT`s on objects other than views, types, functions and extensions, and dependencies of functions on tables (PostgreSQL does not record what a function body reads).

## Reading table rows (adapter layer, data viewer M1)

`getRows(table, options)` is the first method that returns table **data**. It was built and tested at the adapter layer first (M1 of `docs/data-viewer-plan.md`); the server layer (M2) and the screens (M3, M4) follow below. It is opt-in per connection and off by default.

**One fixed statement** (`buildRowsQuery`, a pure function with exact-text tests): `SELECT 1 AS r, left(CAST("col" AS text), $1) AS c0, ..., CAST("key" AS text) AS k0 FROM "schema"."table" [WHERE ROW("key") > ROW($2)] [ORDER BY "key"] LIMIT $n [OFFSET $m]`. Identifiers come from the catalog and are quoted by `quoteIdentifier` (now in `database-core`, shared with the web app); aliases are positions, so no column name becomes an alias; the page size and the paging position are bound parameters; nothing from the caller becomes SQL text. It runs through the same read-only transaction and statement timeout as every other read.

**Values are text, cut in the database.** `CAST(col AS text)` removes driver type surprises and `left(..., 2001)` cuts a long value before it travels, so a 1,000,000-character value arrives as 2,000 characters flagged `truncated`. `CAST(boolean AS text)` is `true`/`false`, not psql's `t`/`f`. SQL NULL stays `null`, distinct from the empty string.

**Which key.** Primary key, else a unique index that is valid, live, over plain columns, not partial, with every key column `NOT NULL` (INCLUDE columns do not count); the narrowest wins. A materialized view's columns are never `NOT NULL`, so it is read unordered even with a unique index. Without a key the page is unordered and paged by position, down to 10,000 rows (`offsetCapped`). **The key is selected a second time, untruncated** (`k0`...), because the paging cursor must hold the real key; a test with keys longer than the cell limit fails if the key is cut.

**Shared, pure pieces in `database-core` (`rows.ts`)**, so the mock and the PostgreSQL adapter cannot drift: `isSensitiveColumnName` (masking by name: a column that looks sensitive is not read at all unless revealed by name; names are only a hint), the cursor codec (plain ASCII, untrusted: bounded, strictly shaped, used only as bound parameters; a forged cursor can only move where the page starts), `normalizeRowsOptions` and `buildRowPage` (cell limit, response limit of about 2 MB that always keeps one row, next cursor). New error codes `invalid_request` and `not_supported` (a foreign table is refused before it is touched).

**No value in an error.** PostgreSQL's own message for a bad value contains the value, so a SQLSTATE class 22 error becomes `invalid_request` with a fixed message, and `permission_denied` keeps its fixed text. Tests forge a cursor with a distinctive value and assert it appears nowhere in the error. **Found by the tests:** a statement with a parameter nothing refers to is refused by PostgreSQL (42P18), which is what a table whose every column is masked produced until the cell limit stopped being passed when no column uses it.

Tests: the shared contract (mock and PostgreSQL), exact statement text, every type in the plan's list, truncation (including a surrogate pair at the cut and 2,000 against 2,001 characters), composite and long keys, every kind of key and non-key, masking and reveal, a table with no columns, 301 columns, awkward names, a view, a materialized view, a partitioned table, a foreign table, row-level security and a role without `SELECT`, the awkward-schema fixture read table by table, and two guards that no snapshot or structure capture ever calls `getRows`.

### The server layer for rows (data viewer M2)

Two routes and one service method sit in front of `getRows`. The screens (M3) call them; nothing else does.

| Method and path                        | Purpose                                                                                               | Success                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------- |
| `POST /api/connections/:id/rows`       | one page of a table's rows (`{ schema, table, pageSize?, cursor?, revealColumns?, sort?, filters? }`) | `{ page }`, `no-store` |
| `PUT /api/connections/:id/data-access` | switch viewing table data on or off (`{ enabled }`)                                                   | `{ connection }`       |

**The setting.** `dataAccess` is a boolean on the connection summary: **off unless asked for**, set when connecting (`dataAccess` in the connect request, which is never sent to the database and is stripped from the resolved connection) or later through the route, and **remembered with a saved connection**. The saved-connections file is now version 2; the 1 to 2 migration gives every existing profile `dataAccess: false`, so an upgrade never makes anything readable, and a version 2 file without the flag is refused (it is never assumed on). Reopening a saved connection brings its setting back unless the request says otherwise. Switching it saves the profile **first** and the in-memory setting second, so a disk failure changes nothing.

**The refusal comes first.** `ConnectionService.getRows` checks the connection's own `dataAccess` **before it touches the database or even resolves the table**, so a switched-off connection cannot be used to learn whether a table exists; it answers `403 data_access_disabled` with a fixed message. It is the only place an adapter's `getRows` is called for the browser. Rules in `tests/security.test.ts` fail if any other app file calls `getRows`, if the refusal moves after the adapter is used, if the rows route accepts anything but a JSON `POST` or loses `no-store`, if the settings route accepts anything but a `PUT`, or if any file in the row path (service, gate, routes, adapter, core helpers) mentions `console.`. Workspaces, snapshots and profiles have no schema that could hold a page.

**One page at a time per connection** (`RowsGate`): a read runs, up to three more wait their turn, and further requests are refused with `429 rows_busy`, so rapid paging cannot crowd the connection pool or queue without limit. A failed read never blocks the ones behind it.

**The request is strict.** `rowsRequestSchema` is a strict object: there is no `where`, `orderBy`, `limit`, `offset`, `columns` or `sql` key, so the shape of the query never depends on the caller (every one of those is tested to be refused). A page size is 1 to 200 (default 50), a cursor at most 4,096 characters, at most 100 names to reveal.

**No value in a log or an error.** The route tests make the adapter throw an error whose message and `cause` contain a distinctive value and assert it appears in neither the response nor any `console` call; a forged cursor is never echoed back; a successful read writes nothing to the console.

New error codes: `data_access_disabled` (403), `rows_busy` (429); the adapter's `invalid_request` and `not_supported` map to 400.

### The screens for rows (data viewer M3)

The Data section is the first place the product shows rows. Everything is opt-in and off by default. The README, SECURITY.md, the threat model and the guide describe it as of the release that ships it (1.2.0, M5).

**Switching it on.** A checkbox "Allow viewing table data" in the connect dialog (a reopened saved connection brings its own setting back), a switch and an "on" badge on each connection in the sidebar, and, in the section itself, an explanation with an "Allow viewing table data" button while it is off and a "Turn off" button while it is on. All of them call `PUT /api/connections/:id/data-access` through the store (`setDataAccess`), which mirrors the answer into the connection and the saved list. While it is off the section requests nothing and the page holds no row. The connect dialog's old note ("only reads the structure, never its rows") is replaced by "By default DataCanvas reads only the structure".

**The section** (`features/data`, mounted at the top of `TableDetails`): a real `<table role="grid">` with a caption, a sticky header, monospace values and a tab stop on one cell (arrow keys, Home, End and Page Up/Down move; Enter or a click opens a value in a dialog with a copy button and a note when it was cut). Four kinds of cell never look alike: NULL (italic), the empty string ("(empty)"), a hidden column (dots, announced as "hidden") and a value; a value cut for the grid or by the server ends in "…". A column hidden because its name looks sensitive has a "Show" button in its header, which re-reads the page with that column named; "Hide" reads it again without. Under the grid, short notes say how the table is ordered, how many columns were left out, how many were hidden, and when a page was shortened or the depth limit reached. A foreign table says its rows are not shown.

**Paging** (`paging.ts`, a reducer with no React in it): the server's cursor only goes forward, so the browser keeps the cursors of the pages it has shown (the trail) and Previous pops it. A new page size starts again from the first page, because every page would start somewhere else. The page being left stays on screen, dimmed, while the next one loads, and an answer that arrives for a page no longer wanted is ignored.

**Rows live in component state only.** `useRows` holds the page in `useState`; it is dropped when the view goes away (another table, another connection, switching access off, a disconnect). Rules in `tests/security.test.ts` fail if anything in `features/data` mentions `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `caches.`, `persist(` or `console.`; if any file other than the API module and the hook asks for rows; if the hook uses a store; or if the stores, the autosave or the canvas code can see `getRows`, `RowPage` or `RowCell`. The browser test also checks that a hidden column's value is nowhere in the page, that nothing is left in `localStorage` or `sessionStorage`, and that no row remains in the page after access is switched off or the connection is closed.

Tests: the paging rules, the cell and note rules (pure), and ten Playwright tests (`e2e/data-viewer.spec.ts`) against a real database: off by default and nothing read, switching on, paging forward and back to the last page, NULL against the empty string, hidden and revealed columns, a long value in the dialog, keyboard use, awkward names, a table without a key, switching off in the sidebar, no row left after disconnect, a saved connection that remembers the choice, and dark mode. **Not in M3:** a blur toggle and the row-level-security notice (added in M4, below). Sort and filter are designed in `docs/data-sort-filter-plan.md` and not built.

**Added in M4 (polish).** The page now says whether row-level security can hide rows from the connected role (`rowSecurity`: `off`, `applies` or `exempt`, read with one catalog query in the same read-only transaction), and the section shows a note only when it applies. A "Blur values" switch blurs every value in the grid and the cell dialog for screen sharing: an in-memory boolean (`blur-store.ts`, never persisted, one per page load), applied through a CSS rule on the grid so no cell re-renders; it changes how values look and nothing about what is read. Grid rows are memoised, so moving between cells of a 20,000-cell page costs about 9 ms. The cell dialog keeps its content only until its closing animation ends. Details and measurements are in `docs/data-viewer-plan.md`, section 18.

**The wording changed with the release (M5).** The product-wide promises now say "by default only metadata is read; with data viewing switched on, rows too": `README.md`, `SECURITY.md`, `docs/threat-model.md` (a new asset, "table contents", and a table of side doors: logs, errors, files, caches, secrets, screen sharing, load, injection, row-level security), `docs/getting-started.md` (a "Look at the rows" section), the connect dialog and the issue template. Statements about one tab ("this tab reads no table rows") stay and say "this tab" so they cannot be read as a claim about the product. `tests/security.test.ts` fails if a product-wide document goes back to saying rows are never read.

**Sorting rows (sort and filter, S1a).** The adapter layer can read a page sorted by one column: `RowsOptions.sort`, `RowColumn.kind` (`text`, `ordered`, `other`, from the catalog), `RowPage.sort` and `sortValueTooLong`, a cursor that carries the last row's sort value, and a shorter time limit (5 seconds, or the adapter's own if smaller) whose cancellation is the new `too_slow` code (HTTP 422). The statement stays one of a small written family of shapes made of fixed fragments and quoted catalog names, with every value a bound parameter; a generated test enforces the grammar. A hidden column, a column whose type has no useful order and a table without a key cannot be sorted. **No route, screen or filter uses it yet** (S1b, S2 and S3 of `docs/data-sort-filter-plan.md`); the data viewer behaves as before.

**Filtering rows (sort and filter, S1b).** `RowsOptions.filters` takes up to three conditions, all required: `{ column, op, value? }` with an operator from a fixed list (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `starts_with`, `is_null`, `is_not_null`). `filterOpsFor(kind)` says which a column allows (text: all; ordered: all but contains and starts with; other: the two null tests); a hidden column, a column that was not read and an operator the kind does not allow are refused with a fixed message. In the statement the operator's SQL comes from a table keyed by its name (own keys only), the column is a quoted catalog name, and the value is a bound parameter; `contains` and `starts with` avoid `LIKE`, so no value contains a wildcard. The page echoes the conditions. A filtered read has the same shorter time limit as a sorted one. **Still no route or screen** (S2, S3).

**Sort and filter on the server (S2).** `POST /api/connections/:id/rows` takes `sort` (`{ column, direction }`) and `filters` (up to three `{ column, op, value? }`) next to the existing keys. The request schema is strict at every level, and the service hands both to the adapter untouched. A read the shorter time limit stops is `422 too_slow` with a fixed sentence. **Still no screen** (S3).

**Sorting in the Data section (S3a).** Each sortable column header is a button (`aria-sort` on the header) that cycles ascending, descending and back to the key order. The sort is part of the paging state (`paging.ts`), so a change starts again from the first page, and it goes when its column is hidden again. A column that cannot be sorted says why in a tooltip (`sorting.ts`, `whyNotSortable`). The note under the grid describes the order the server used. Nothing about the sort is stored outside the component's state. **The filter panel is S3b.**
