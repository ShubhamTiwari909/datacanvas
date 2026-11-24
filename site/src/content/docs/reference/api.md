---
title: HTTP API
description: Every route under /api and the POST /mcp door, grouped by area, with HTTP method and purpose. The API is internal to the app, not a public integration surface.
---

The API exists so the DataCanvas UI can reach the local server. It is **not** presented by the project as a
public or stable integration surface (**Unknown**: the repository does not state any compatibility promise).
Every request must pass the [local-server guard](/security/local-server/): a foreign Host or Origin is
refused, and everything except `/api/health` needs the session cookie. (`POST /mcp` is the one exception,
with a token of its own; see below.)

## Conventions

- **Bodies are JSON** with `Content-Type: application/json`, validated by strict Zod schemas (unknown keys
  are rejected). Query strings are validated too.
- **Responses are `no-store`** JSON. Errors use one shape (see [Error codes](/reference/error-codes/)):
  `{ "error": { "code": "…", "message": "…", "issues"?: [{ "path", "message" }] } }`.
- `:id` is an **opaque connection id** from `POST /api/connections`.
- Unknown `/api/*` URLs return the standard JSON `not_found`, never HTML.
- Methods listed below were read from the `route.ts` exports in `apps/web/app/api`.

## Health

| Method | Path          | Purpose                                                                                                   |
| ------ | ------------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health` | `{ status: "ok", application: "datacanvas" }`. The only path without the session token; the CLI polls it. |

## Connections

| Method | Path                               | Purpose                                                               |
| ------ | ---------------------------------- | --------------------------------------------------------------------- |
| GET    | `/api/connections`                 | List live connections (summaries, no password).                       |
| POST   | `/api/connections`                 | Connect (optionally `remember` or `profileId`); 201 `{ connection }`. |
| POST   | `/api/connections/test`            | Check details, remember nothing.                                      |
| DELETE | `/api/connections/:id`             | Disconnect and forget credentials.                                    |
| POST   | `/api/connections/:id/save`        | Save a live connection as a profile.                                  |
| PUT    | `/api/connections/:id/data-access` | Switch data viewing on or off (`{ enabled }`).                        |
| GET    | `/api/connections/:id/role`        | Facts about the connected role, for warnings.                         |

## Structure (metadata only)

| Method | Path                                                    | Purpose                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/connections/:id/schemas`                          | Schemas.                                                                                                                                                                                                                                                |
| GET    | `/api/connections/:id/tables?schema=`                   | Tables, views, materialized views, foreign tables.                                                                                                                                                                                                      |
| GET    | `/api/connections/:id/tables/:table?schema=`            | Columns, constraints and indexes of one table.                                                                                                                                                                                                          |
| POST   | `/api/connections/:id/table-details`                    | The same for many tables (at most 500 per request).                                                                                                                                                                                                     |
| GET    | `/api/connections/:id/tables/:table/statistics?schema=` | The server's own figures for one table (1.10.0): share of NULLs, distinct values, width, order of each column, sizes, last vacuum and analyze. `{ statistics }`, null for a view or foreign table. **No row or value is read, no data viewing needed.** |
| GET    | `/api/connections/:id/relationships`                    | Every declared foreign key.                                                                                                                                                                                                                             |
| GET    | `/api/connections/:id/objects`                          | Views, types, sequences, functions, triggers, extensions, policies.                                                                                                                                                                                     |
| GET    | `/api/connections/:id/index-usage`                      | Index usage counters, reset time, standby flag.                                                                                                                                                                                                         |
| GET    | `/api/connections/:id/search?q=&limit=`                 | Tables and columns by name (query 1–100 characters, at most 50 results; `%` and `_` literal).                                                                                                                                                           |
| GET    | `/api/connections/:id/structure`                        | The live structure (what a snapshot would hold); nothing is saved.                                                                                                                                                                                      |

## Rows (need data viewing on, otherwise `403 data_access_disabled`)

| Method | Path                                  | Purpose                                                                                                                                                                                                              |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/connections/:id/rows`           | One page: `{ schema, table, pageSize?, cursor?, revealColumns?, sort?, filters? }` → `{ page }`.                                                                                                                     |
| POST   | `/api/connections/:id/rows/cell`      | One `json`/`jsonb` value read whole, by the row's key.                                                                                                                                                               |
| POST   | `/api/connections/:id/rows/export`    | The rows as a **file** (`csv`, `tsv`, `json`, `ndjson`, `sql` = a script of INSERT statements), streamed. Optional `keys`: only the chosen rows (up to 500, each by the whole key); the body may then be up to 4 MB. |
| POST   | `/api/connections/:id/rows/validate`  | Would the database accept these values? No row is written.                                                                                                                                                           |
| POST   | `/api/connections/:id/rows/preflight` | Counts of rows that would make migration steps fail.                                                                                                                                                                 |
| POST   | `/api/connections/:id/run`            | **The one SQL route**: one read-only statement `{ text, maxRows?, timeoutMs? }`.                                                                                                                                     |

## Claude reading a connection (1.11.0, behind the cookie)

These are the person's side of [Use DataCanvas from Claude](/guides/use-with-claude/). Claude's own calls go to
`POST /mcp` (below), which cannot reach any of them.

| Method   | Path                          | Purpose                                                                                                                                                                                                                                                                                                                   |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET, PUT | `/api/connections/:id/claude` | Read or set the sharing: `{ level: "off" \| "structure" \| "data", acknowledgeRole?, approval? }` → `{ sharing: { level, approval } }`. In memory only. The data level needs data viewing (`403 data_access_disabled`) and, for a superuser or file-reading role, `acknowledgeRole` (`409 claude_role_not_acknowledged`). |
| GET      | `/api/claude/activity`        | `{ paused, shared[], pending[], activity[] }`: what is shared, the calls waiting for Approve, and what Claude asked (the last 200; counts, never a returned value). Polled by the browser every 1.5 s while something is shared.                                                                                          |
| POST     | `/api/claude/pending/:id`     | Answer a waiting call: `{ decision: "approve" \| "deny" }`. `404 not_found` when it is no longer waiting.                                                                                                                                                                                                                 |
| PUT      | `/api/claude/pause`           | `{ paused: boolean }`: refuse every call of Claude at once (and deny the waiting ones), or resume.                                                                                                                                                                                                                        |

## The door for Claude: `POST /mcp` (1.11.0)

Not under `/api`, not for the browser, and **not behind the cookie**: a different guard with a token of its
own. See [Protecting the local server](/security/local-server/#the-door-for-claude-mcp-1110).

| Method      | Path   | Purpose                                                                                                                                                                               |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST        | `/mcp` | One JSON-RPC 2.0 message (or a batch of at most 20) of the Model Context Protocol: `initialize`, `ping`, `tools/list`, `tools/call`. Stateless, one JSON answer; body at most 256 KB. |
| GET, DELETE | `/mcp` | `405` (no stream, no session).                                                                                                                                                        |

- **Auth:** `Authorization: Bearer <token>` where the token is `DATACANVAS_MCP_TOKEN` (made for each run, kept
  in `mcp.json`); the **session token and the cookie are refused here, and this token is refused on `/api`**.
  The Host check applies; **a request with an `Origin` or `Sec-Fetch-Site` header is refused (403)**; no CORS
  headers.
- **404** while no token is configured and **while no connection is shared**, before the body is read.
- **Tools:** fifteen, read-only, strict input schemas: `list_connections`, `list_schemas`, `list_tables`,
  `describe_table`, `search_objects`, `get_health`, `get_sizes`, `list_objects`, `find_path`,
  `compare_structure`, `generate_migration` and the data tools `read_rows`, `run_readonly_query`,
  `explain_query`, `check_migration_against_data`. Every tool is listed at every level; a data tool refuses a
  connection that is not at the data level. Details and limits: [MCP server](/architecture/mcp/) and
  [Limits](/reference/limits/#claude-reading-a-connection-mcp-1110).
- **Errors** do not use the `/api` shape (see [Error codes](/reference/error-codes/)).
- Most clients do not call it directly: the bridge `datacanvas mcp` does ([CLI](/start/cli/)).

## Writes (need `--enable-writes`, a local host, and the unlock)

| Method | Path                                    | Purpose                                                                   |
| ------ | --------------------------------------- | ------------------------------------------------------------------------- |
| GET    | `/api/connections/:id/writes`           | Write status for the connection.                                          |
| POST   | `/api/connections/:id/writes/unlock`    | Unlock by typing the database name.                                       |
| POST   | `/api/connections/:id/writes/lock`      | Lock again.                                                               |
| POST   | `/api/connections/:id/writes/edit-info` | What can be edited in a table (key, columns, why not).                    |
| POST   | `/api/connections/:id/writes/preview`   | Plan a change; returns statement text, effect, warnings and a preview id. |
| POST   | `/api/connections/:id/writes/apply`     | Apply a preview by id (once, within five minutes).                        |
| GET    | `/api/connections/:id/writes/history`   | This session's changes (no row values).                                   |
| GET    | `/api/connections/:id/writes/migration` | This session's structure changes as one SQL script.                       |

## Saved data

| Method           | Path                                  | Purpose                                                                      |
| ---------------- | ------------------------------------- | ---------------------------------------------------------------------------- |
| GET              | `/api/profiles`                       | Saved connection profiles.                                                   |
| DELETE           | `/api/profiles/:id`                   | Forget a profile **and delete its workspaces**.                              |
| GET              | `/api/workspaces[?profileId=]`        | Workspace summaries, newest first.                                           |
| GET, PUT, DELETE | `/api/workspaces/:id`                 | Read, create or update (client chooses the id, server stamps times), delete. |
| GET              | `/api/workspaces/:id/export`          | Download `<name>.datacanvas.json`.                                           |
| POST             | `/api/workspaces/import[?profileId=]` | Validate, upgrade and save as a new workspace.                               |
| GET              | `/api/snapshots`                      | Snapshot summaries, newest first.                                            |
| POST             | `/api/connections/:id/snapshots`      | Take a snapshot (`{ name? }`).                                               |
| GET, DELETE      | `/api/snapshots/:id`                  | Full snapshot / delete.                                                      |
| GET              | `/api/snapshots/:id/export`           | Download `.snapshot.json`.                                                   |
| POST             | `/api/snapshots/import`               | Import file content as a new snapshot.                                       |

## Guard rails that apply everywhere

- Every route runs inside `handleRoute`, which repeats the Host, Origin and token checks; a rule test fails if
  a route does not.
- No route accepts SQL except `…/run` (and, through `/mcp`, the data tool `run_readonly_query`, which calls the
  same read-only runner and only while a connection is shared at the data level).
- Success and failure responses never contain the database password, and error logs hold only names and codes.

---

**Sources:** the `route.ts` files under
[`apps/web/app/api/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/app/api),
[`apps/web/app/mcp/route.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/app/mcp/route.ts), [`apps/web/app/api/claude/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/app/api/claude),
[`tests/security.test.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/tests/security.test.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (API tables in Phases 6 and 8 and the snapshot section).
Request and response schemas are defined in
[`packages/shared-types/src/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/packages/shared-types/src); this page does not reproduce them.
The purposes of `…/role`, `…/index-usage` and `…/rows/preflight` come from route and module headers; the HTTP methods were all read from source.
