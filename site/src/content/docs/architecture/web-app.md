---
title: Web app
description: "How apps/web is organised: App Router entry points, route handlers, the server layer, client stores, and feature folders."
---

`apps/web` is a Next.js 16 App Router application (`@datacanvas/web`, private). Its scripts: `dev`
(`next dev -H 127.0.0.1 -p 4747`), `build` (`next build`) and `typecheck` (`tsc --noEmit`).

## Folder map

```text
apps/web/
├── app/
│   ├── layout.tsx, page.tsx, loading.tsx, error.tsx, globals.css
│   ├── api/                    route handlers (one route.ts per URL)
│   └── mcp/route.ts            POST /mcp, the door for Claude (its own guard and token)
├── components/
│   ├── layout/                 AppShell, Header, Sidebar, ThemeToggle, MobileNavButton
│   ├── states/                 LoadingState, EmptyState, ErrorState
│   └── ui/                     shadcn-style primitives (Button, Dialog, Select, Switch, …)
├── features/                   one folder per product area (see below)
├── lib/
│   ├── api-client.ts           browser → API calls that never throw
│   ├── security/               request-guard.ts (cookie guard and the /mcp guard), csp.ts (page policy)
│   ├── server/                 services, registries, storage, error handling
│   └── theme.ts, sql-text.ts, use-async-data.ts, …
├── stores/                     Zustand stores
├── proxy.ts                    the front door (Next.js 16 "middleware")
├── instrumentation.ts          registers graceful shutdown
└── next.config.ts              standalone output, headers, body buffer size
```

### Server vs client components

Files under `app/` are **Server Components** by default. A file is a Client Component only if it starts with
`"use client"`; that is needed for state, effects and browser events. The project's rule of thumb is to keep
`"use client"` on the smallest, leaf-most component that needs it. Error boundaries must be client components.

## Feature folders

| Folder                           | Responsibility                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `connections/`                   | Connect dialog and form, saved connections, the sidebar list, the welcome panel        |
| `explorer/`                      | Workspace tabs, schema tree with table search, table details, `load-all-tables`        |
| `canvas/`                        | React Flow canvas, table node, toolbar, search, inspector, ELK layouts, image export   |
| `overview/`, `paths/`, `health/` | The structure-only tabs (pure functions plus loaders and views)                        |
| `objects/`                       | The Objects tab and its list helpers                                                   |
| `snapshots/`                     | Snapshots tab: API calls, compare, diff view                                           |
| `migrations/`                    | Migrations tab, plan view, pre-flight panel                                            |
| `data/`                          | The Data section: grid, paging, sorting, filtering, export, cell dialog, blur          |
| `json/`                          | JSON editor, tree and diff                                                             |
| `import/`                        | CSV parse and import plan                                                              |
| `writes/`                        | Row editing, bulk dialogs, create and alter table, unlock, history, validation panel   |
| `sql/`                           | SQL tab: Monaco editor, completion, tabs, results, history                             |
| `docs/`                          | Export documentation: Markdown, Mermaid, DBML and PlantUML from the structure (1.10.0) |
| `claude/`                        | Share with Claude: sidebar control, share dialog, approval prompt, setup text (1.11.0) |
| `workspaces/`                    | Serialise, restore, autosave, import and export of layouts                             |

## Stores (Zustand)

| Store                                           | Holds                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `workspace-store`                               | Connection summaries, selected connection and table, dialog state                                      |
| `metadata-store`                                | **Cache** of database structure per connection (tables, columns, relationships)                        |
| `canvas-store`                                  | **Layout** per connection: which tables, where, expanded, selected                                     |
| `canvas-view-store`                             | Filters, focus mode, hop count, direction, inspector visibility (not saved with a workspace)           |
| `persistence-store`, `nav-store`, `theme-store` | Saved profiles and workspaces, drawer state, theme                                                     |
| `sql-store`, `writes-store`                     | SQL tabs and history; unlock state and session changes. **Memory only**                                |
| `claude-store`                                  | What is shared with Claude and the activity from the server; polls only while sharing. **Memory only** |

Design points: a canvas **node** holds only identity (`schema`, `name`, `expanded`, `columnCount`), and
columns are read from the metadata store so there is one copy. Edges are derived, not stored. Rows live in
component state only (`useRows`), never in a store, and rule tests fail if stores, autosave or canvas code
can see row types.

## Server layer (`lib/server`)

| File                                                                                               | Responsibility                                                                                                                               |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.ts`                                                                                       | Composition root (see [Request lifecycle](/architecture/request-lifecycle/))                                                                 |
| `connection-registry.ts`                                                                           | In-memory map opaque id → `{ summary, adapter }`; the **only** place credentials live; connection limit; idle sweeper; the write unlock flag |
| `connection-service.ts`                                                                            | Test, create, list, delete and every read operation; knows only the `DatabaseAdapter` interface                                              |
| `write-service.ts`, `preview-store.ts`                                                             | The write capability; planned changes held for a short time                                                                                  |
| `sql-service.ts`                                                                                   | The SQL tab's single route's logic (also used by the MCP data tools)                                                                         |
| `mcp-service.ts`, `mcp-control.ts`, `mcp-data.ts`                                                  | Claude reading a shared connection: levels, tools, approval, pause, rate limit, what may be said. See [MCP server](/architecture/mcp/)       |
| `snapshot-service.ts`, `workspace-service.ts`, `profile-service.ts`, `storage/`                    | Persistence, see [Persistence](/architecture/persistence/)                                                                                   |
| `rows-gate.ts`                                                                                     | One page read at a time per connection; others wait or get `429`                                                                             |
| `error-response.ts`, `api-response.ts`, `route-support.ts`, `parse-request.ts`, `service-error.ts` | Uniform errors and request parsing                                                                                                           |
| `migration-file.ts`                                                                                | Builds migration export files                                                                                                                |
| `shutdown.ts`                                                                                      | Close every session and forget credentials on stop                                                                                           |

## Performance measures on the canvas

Only visible nodes and edges are rendered (`onlyRenderVisibleElements`); nodes are memoised and read their
own slice of the store; edges are not recomputed while dragging; the ELK layout engine is loaded on demand;
the structure of many tables is fetched with **four queries** regardless of how many tables (bulk
`getTablesDetails`).

---

**Sources:** [`apps/web/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web) (folder listing and file
headers), [`apps/web/package.json`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/package.json),
[`apps/web/stores/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/stores),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Phases 1, 6, 7, 9; Claude reading a connection).
Store descriptions for `persistence-store` and `nav-store` beyond their names and the nav drawer flag are **Inference**.
