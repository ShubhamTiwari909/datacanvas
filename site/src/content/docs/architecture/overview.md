---
title: Architecture overview
description: The monorepo layout, the layering rule that keeps database code out of the web framework, and the dependency edges between workspaces.
---

DataCanvas is one npm **workspace monorepo** (`workspaces: ["apps/*", "packages/*"]` in the root
`package.json`) that produces **one published package**, `@shubhamtiwari909/datacanvas`. The root package
`datacanvas-monorepo` is private and never published.

```text
pg-visualizer/
├── apps/web/            Next.js 16 app: the interface and every /api route handler
├── packages/
│   ├── shared-types/    constants and Zod schemas (API contracts)
│   ├── database-core/   database-agnostic models, adapter interfaces, errors, pure logic
│   ├── postgres-adapter/ PostgreSQL implementation (the `pg` driver, catalog queries)
│   ├── mcp/             the Model Context Protocol (JSON-RPC, tools only): pure, no network, no framework
│   ├── canvas-engine/   pure canvas logic: sizing, layout, edges, graph, search, filters
│   └── cli/             the `datacanvas` command
├── scripts/             package assembly, verification, release gate, publishing
├── e2e/                 Playwright browser tests
├── tests/               architecture and security rule tests
├── examples/            sample databases and a disposable PostgreSQL (docker-compose)
└── docs/                the project's long-form notes (authoritative source for this site)
```

## One process, one port

The browser talks to a Next.js server that serves both the UI and the API from **one process on
`127.0.0.1`**. There is no separate backend and no CORS (decision 1 in `docs/decisions.md`: a browser
cannot speak the PostgreSQL protocol, Next.js already runs Node, and one app means one process and the
simplest `npx` packaging).

```text
Browser ─▶ Next.js app (UI + /api route handlers, one process, 127.0.0.1)
              ─▶ services (lib/server)
                   ─▶ database-core (interfaces)
                        ─▶ postgres-adapter (pg)
                             ─▶ PostgreSQL
```

Since 1.11.0 the same process also answers `POST /mcp` for a Claude app (through the `datacanvas mcp`
stdio bridge), with a token and a guard of its own. It reaches the database only through the services above
(the SQL runner and the page reader), and the person's side of it (share, approve, pause) is ordinary
cookie-guarded `/api` routes. See [MCP server](/architecture/mcp/).

```text
Claude app ─▶ datacanvas mcp ─▶ POST /mcp ─▶ McpService ─▶ the same services (lib/server) ─▶ …
```

## The layering rule

Route handlers stay **thin**: validate with Zod, call a service, return JSON. Database logic lives in
**framework-free packages**, so a dedicated server stays possible later. Higher layers depend on an
**abstraction** (the `DatabaseAdapter` interface), not on a driver, so swapping or adding a database means
writing one new adapter and registering it. PostgreSQL is the only provider today (decision 2).

## Workspace dependency edges

Declared in each package's `dependencies`:

| Workspace          | Depends on                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `database-core`    | nothing (a test fails if it declares any dependency)                                                                          |
| `shared-types`     | `zod`; `database-core` as a dev dependency (types only)                                                                       |
| `postgres-adapter` | `database-core`, `shared-types`, `pg`                                                                                         |
| `canvas-engine`    | `database-core` only (a test fails otherwise)                                                                                 |
| `mcp`              | `zod` only (a test fails if any file imports anything else, or uses `fetch(`, `node:http`, `node:net` or `process.`); private |
| `cli`              | `shared-types` (bundled into one file at package time)                                                                        |
| `apps/web`         | `canvas-engine`, `database-core`, `mcp`, `postgres-adapter`, `shared-types`, plus the UI stack                                |

Build time: packages compile with TypeScript project references (`tsc -b`, root `tsconfig.json` lists the
six packages), each emitting `dist/`. A workspace imports another through the npm symlink to its
`package.json` `exports`, which points at `dist/`, so packages must be built before the web app runs.
That is why root `dev` and `build` start with `tsc -b`.

## The UI stack

React 19, Next.js 16 (App Router, `output: "standalone"`), Tailwind 4, shadcn-style components over Radix,
Zustand for client state, `@xyflow/react` for the canvas, `elkjs` for automatic layouts, `html-to-image` for
image export and `monaco-editor` 0.57.0 for the SQL and JSON editors. These are read from
`apps/web/package.json`.

## Decisions worth knowing

`docs/decisions.md` has 169 numbered records (the latest: 163 to 168 for 1.10.0, 169 for the MCP server). A few that shape everything:

- **No native modules and no postinstall scripts** (decision 3): the user needs only Node.js and one `npx`
  command, so no OS-keychain password storage and no Next.js image optimizer (`sharp`).
- **Files, not browser storage**, for persistence, so a changed port cannot hide your data.
- **Everything that reads rows is opt-in and gated**; **everything that writes is behind three switches**.
- **Claude reads only what you share, and cannot change anything**: thirteen read-only tools pinned by a
  test, behind a door with its own token (decision 169).
- **Security rules are tests**, not only prose. See [Security model](/security/model/).

---

**Sources:** root [`package.json`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/package.json),
[`tsconfig.json`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/tsconfig.json), each
`packages/*/package.json`, [`apps/web/package.json`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/package.json),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md),
[`docs/mcp-server-plan.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/mcp-server-plan.md),
[`docs/decisions.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/decisions.md),
[`tests/architecture.test.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/tests/architecture.test.ts).
The ASCII diagram is a summary (**Inference**) of the target architecture in `docs/architecture.md`.
