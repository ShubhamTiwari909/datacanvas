---
title: HTTP API
description: Every route under /api, grouped by area, with HTTP method and purpose. The API is internal to the app, not a public integration surface.
---

The API exists so the DataCanvas UI can reach the local server. It is **not** presented by the project as a
public or stable integration surface (**Unknown**: the repository does not state any compatibility promise).
Every request must pass the [local-server guard](/security/local-server/): a foreign Host or Origin is
refused, and everything except `/api/health` needs the session cookie.

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

| Method | Path                                         | Purpose                                                                                       |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/api/connections/:id/schemas`               | Schemas.                                                                                      |
| GET    | `/api/connections/:id/tables?schema=`        | Tables, views, materialized views, foreign tables.                                            |
| GET    | `/api/connections/:id/tables/:table?schema=` | Columns, constraints and indexes of one table.                                                |
| POST   | `/api/connections/:id/table-details`         | The same for many tables (at most 500 per request).                                           |
| GET    | `/api/connections/:id/relationships`         | Every declared foreign key.                                                                   |
| GET    | `/api/connections/:id/objects`               | Views, types, sequences, functions, triggers, extensions, policies.                           |
| GET    | `/api/connections/:id/index-usage`           | Index usage counters, reset time, standby flag.                                               |
| GET    | `/api/connections/:id/search?q=&limit=`      | Tables and columns by name (query 1–100 characters, at most 50 results; `%` and `_` literal). |
| GET    | `/api/connections/:id/structure`             | The live structure (what a snapshot would hold); nothing is saved.                            |

## Rows (need data viewing on, otherwise `403 data_access_disabled`)

| Method | Path                                  | Purpose                                                                                          |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| POST   | `/api/connections/:id/rows`           | One page: `{ schema, table, pageSize?, cursor?, revealColumns?, sort?, filters? }` → `{ page }`. |
| POST   | `/api/connections/:id/rows/cell`      | One `json`/`jsonb` value read whole, by the row's key.                                           |
| POST   | `/api/connections/:id/rows/export`    | The rows as a **file** (`csv`, `tsv`, `json`, `ndjson`), streamed.                               |
| POST   | `/api/connections/:id/rows/validate`  | Would the database accept these values? No row is written.                                       |
| POST   | `/api/connections/:id/rows/preflight` | Counts of rows that would make migration steps fail.                                             |
| POST   | `/api/connections/:id/run`            | **The one SQL route**: one read-only statement `{ text, maxRows?, timeoutMs? }`.                 |

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
- No route accepts SQL except `…/run`.
- Success and failure responses never contain the database password, and error logs hold only names and codes.

---

**Sources:** the `route.ts` files under
[`apps/web/app/api/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/app/api),
[`tests/security.test.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/tests/security.test.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (API tables in Phases 6 and 8 and the snapshot section).
Request and response schemas are defined in
[`packages/shared-types/src/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/packages/shared-types/src); this page does not reproduce them.
The purposes of `…/role`, `…/index-usage` and `…/rows/preflight` come from route and module headers; the HTTP methods were all read from source.
