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
