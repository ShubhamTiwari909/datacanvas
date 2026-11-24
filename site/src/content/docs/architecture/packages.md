---
title: Packages
description: What each workspace package owns, its public surface, and the rules that keep it independent.
---

## `@datacanvas/shared-types`

Constants, types and **Zod schemas** shared by the UI, route handlers and CLI. TypeScript types are erased
at compile time, so a JSON body arriving over HTTP has no guaranteed shape; a Zod schema is runtime code
that checks a value and also yields the TypeScript type (`z.infer`), so the validator and type cannot
drift. The browser validates for fast feedback and **the server validates again**.

Files in `src/`: `constants.ts` (`APP_NAME`, `DEFAULT_PORT` = 4747, no Zod so the CLI stays tiny),
`api-error.ts` (the error code list and the `{ error: { code, message, issues? } }` shape),
`postgres-connection.ts` (connection input schemas and the connection-string parser), `connections.ts`,
`metadata.ts`, `profiles.ts`, `workspace.ts`, `snapshots.ts`, `rows` contracts (`row-filters.ts`),
`sql.ts`, `writes.ts`, `versioned-file.ts`, `ids.ts`, `health.ts`. Since 1.10.0 and 1.11.0 the contracts also
cover the table statistics, `format: "sql"` and `keys` of an export request (`connections.ts`), the sharing
with Claude (`claudeLevelSchema`, `claudeSharingRequestSchema`, `claudeActivitySchema`,
`claudeDecisionRequestSchema`, `claudePauseRequestSchema`) and the error code `claude_role_not_acknowledged`. `"sideEffects": false` lets esbuild drop
what the CLI does not use, so the CLI bundle stays small.

## `@datacanvas/database-core`

The vocabulary and contract of every database provider. **No dependencies, no driver, no framework**; a
test (`tests/architecture.test.ts`) fails if it declares any dependency or imports anything but relative
modules (plus `vitest` in test code).

| Area               | Files                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models and errors  | `models.ts`, `errors.ts` (`DatabaseError` with stable codes and safe fixed messages)                                                                        |
| Contracts          | `adapter.ts` (`DatabaseAdapter`, `WritableAdapter`), `sql-run.ts` (`SqlRunnerAdapter`), `registry.ts` (`AdapterRegistry`)                                   |
| Rows               | `rows.ts` (limits, cursor codec, masking, sort and filter rules, page building), `rows-export.ts` (formatters, including the INSERT script, and limits)     |
| Writes             | `changes.ts` (structured changes, bulk and import limits, role info and warnings)                                                                           |
| Structure and diff | `structure.ts`, `diff.ts`, `capture.ts`, `ddl.ts`, `objects.ts`                                                                                             |
| Checking           | `validation.ts` (report and collector), `table-refs.ts`, `sql-text.ts`                                                                                      |
| Migrations         | `migration/` (planning, classification, renames, objects, script, export, pre-flight)                                                                       |
| Testing support    | `testing/` (separate entry points `./testing` and `./contract`): the sample shop fixture, an in-memory `MockDatabaseAdapter`, the shared **contract suite** |

Exports: `.`, `./testing` and `./contract` (see its `package.json` `exports`).

## `@datacanvas/postgres-adapter`

The PostgreSQL implementation: connection handling and catalog introspection. Depends on `database-core`,
`shared-types` and `pg`. Layout of `src/`:

- `connection/`: `config.ts` (settings → pool options, SSL), `errors.ts` (`mapPgError`: anything `pg` or Node
  throws → a safe `DatabaseError`), `read-only.ts` (every query in `BEGIN READ ONLY` with a timeout),
  `write.ts` and `write-errors.ts` (the one transaction that is not read-only, and its fixed error
  mapping), `run-statement.ts` (the SQL tab: one statement, read-only, on a connection opened for that run
  and closed after it), `checking-transaction.ts` (validation: starts read-write only to make a temporary
  copy, then switches to read-only before any value goes in, and always rolls back).
- `introspection/`: one file per kind of metadata, each a fixed, commented SQL query (`schemas`, `tables`,
  `columns`, `constraints`, `indexes`, `relationships`, `objects`, `index-usage`, `role-info`, `rows`,
  `export-rows`, `search`, `preflight`, `ddl-detail`, `statistics` (1.10.0: `pg_stats` and the size and
  upkeep figures, never the value columns) and more).
- `writes/` (builders, catalog checks, guard, row and structure changes) and `validation/`: the statement
  builders behind previews, applies and validation.
- Round-trip tests that run generated migrations on a real server.

Exports `.` and `./testing`.

## `@datacanvas/mcp`

The Model Context Protocol, **tools only**, as a pure function from a request body to an answer (1.11.0,
private workspace package, one dependency: `zod`).

- `jsonrpc.ts`: JSON-RPC 2.0 types and helpers (`ERROR`, `success`, `failure`, `classify`, `MAX_BATCH` = 20).
- `protocol.ts`: `createMcpServer({ name, title, version, instructions, tools })` returns
  `handle(body, context, signal)`; `SUPPORTED_PROTOCOL_VERSIONS`; `MAX_RESULT_CHARS` = 200,000; the four
  methods `initialize`, `ping`, `tools/list`, `tools/call`.
- `tools.ts`: `ToolDefinition` (a strict zod input schema and read-only annotations), `ToolResult`,
  `ToolError`, `READ_ONLY`.
- No network, framework, database or React import, and no `process.` (enforced by `tests/architecture.test.ts`).
  The official MCP SDK is a dev dependency of the tests only (a client).

The tools themselves, and the rules about what they may reach, live in `apps/web/lib/server/mcp-service.ts`.
See [MCP server](/architecture/mcp/).

## `@datacanvas/canvas-engine`

Framework-free canvas logic: node sizing (`columns.ts`, `constants.ts`: width 280, header 40, row 26,
footer 30, collapse limit 12), ids, `layout.ts` (grid and next free position), `edges.ts` (`buildEdges`),
`graph.ts` (`reachableWithin`, `connectedComponents`), `filters.ts`, `pack.ts` (`shelfPack`) and
`search.ts`. Depends on `database-core` only; no React, no canvas library, no browser APIs (enforced).

## `@datacanvas/cli`

The `datacanvas` launcher: `index.ts` (flags and orchestration), `port.ts`, `web-server.ts` (spawn, health
poll, stop), `browser.ts`, `instance.ts` (reuse a running instance via `run.json`), `data-dir.ts`,
`node-version.ts`, `version.ts` (injected at bundle time), and since 1.11.0 `mcp-bridge.ts` (the stdio bridge
`datacanvas mcp`) and `mcp-file.ts` (`mcp.json`). See [CLI and packaging](/architecture/cli-and-packaging/).

## `apps/web`

The Next.js app. See [Web app](/architecture/web-app/).

---

**Sources:** [`packages/mcp/src/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/packages/mcp/src), each package's `package.json` and `src/` under
[`packages/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/packages),
[`tests/architecture.test.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/tests/architecture.test.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md).
Per-file descriptions are summarised from file headers and the repository file list; this page does not describe every
file.
