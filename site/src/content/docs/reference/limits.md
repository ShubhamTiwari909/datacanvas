---
title: Limits
description: The numeric limits DataCanvas enforces, with the constant or document each comes from.
---

Values were taken from source constants where a constant exists; others come from the project's notes and
are marked.

## Connections and the database

| Limit                                 | Value      | Source                                              |
| ------------------------------------- | ---------- | --------------------------------------------------- |
| Live connections                      | 10         | `docs/architecture.md` (`connection_limit_reached`) |
| Connection idle before sessions close | 30 minutes | `connection-registry.ts` default                    |
| Connect timeout                       | 10 s       | `postgres-adapter/src/connection/config.ts`         |
| Catalog statement timeout             | 15 s       | same                                                |
| Pool size per connection              | 3          | same                                                |
| Idle pooled connection closes         | 30 s       | same (`idleTimeoutMillis`)                          |
| Tables per bulk details request       | 500        | `MAX_TABLES_PER_DETAILS_REQUEST`                    |
| Search results                        | 50         | `MAX_SEARCH_RESULTS`                                |
| Tables added to canvas at once        | 1,000      | `MAX_TABLES_ADDED_AT_ONCE`                          |
| Tables checked by Health              | 2,000      | `docs/architecture.md`                              |

## Rows

| Limit                                             | Value                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Page size                                         | 1 to 200 (default 50; the UI offers 25, 50, 100, 200)                                             |
| Cell kept in a page                               | 2,000 characters (grid shows 200)                                                                 |
| Response per page                                 | about 2 MB                                                                                        |
| Columns shown                                     | first 100                                                                                         |
| Position-paged tables (no key, materialized view) | first 10,000 rows                                                                                 |
| Sort or filter read                               | 5 s limit                                                                                         |
| Filter conditions                                 | 10 (`MAX_ROW_FILTERS`), in at most 3 groups (`MAX_ROW_FILTER_GROUPS`)                             |
| Filter value                                      | 200 characters; up to 50 values in a list (`MAX_ROW_FILTER_VALUE_CHARS`, `MAX_ROW_FILTER_VALUES`) |
| One cell read whole (JSON)                        | 1,000,000 characters                                                                              |
| Editable JSON                                     | 100,000 characters                                                                                |
| Hidden columns revealed per request               | 100                                                                                               |
| Concurrent page reads                             | 1 running, 3 waiting, then `429`                                                                  |

## Export

| Limit                                      | Value                                                    | Constant                                      |
| ------------------------------------------ | -------------------------------------------------------- | --------------------------------------------- |
| Rows in one export                         | 100,000                                                  | `EXPORT_MAX_ROWS`                             |
| Size of one export                         | 64 MB                                                    | `EXPORT_MAX_BYTES`                            |
| Time of one export                         | 10 minutes                                               | `EXPORT_MAX_MS` (postgres-adapter)            |
| One cell in an export                      | 1,000,000 characters (a longer value is cut and counted) | `EXPORT_CELL_CHARS`                           |
| Concurrent exports                         | 1 per connection (`export_busy`)                         |                                               |
| Chosen rows (Export chosen, 1.10.0)        | 500                                                      | `keys` of `exportRequestSchema` (`.max(500)`) |
| Parts of one key / one key value           | 32 / 4,096 characters                                    | `exportRequestSchema`                         |
| Key values of one request                  | 1,000,000 characters                                     | `EXPORT_MAX_KEY_CHARS`                        |
| Request body of an export                  | 4 MB (the default 64 KB elsewhere)                       | `EXPORT_MAX_BODY_BYTES`                       |
| Rows to one `INSERT` statement of a script | 100                                                      | `SQL_ROWS_PER_STATEMENT`                      |
| Tables in one documentation file           | 5,000 (then one schema at a time)                        | `DOC_MAX_TABLES` (`docs-export-dialog.tsx`)   |

## SQL tab

| Limit                                          | Value                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Statement                                      | 200,000 characters                                                                              |
| Rows                                           | 1,000 default, 10,000 maximum                                                                   |
| Result bytes                                   | 64 MB read                                                                                      |
| Cell                                           | 2,000 characters                                                                                |
| Time                                           | 30 s default, 5 minutes maximum                                                                 |
| Lock wait                                      | 3 s                                                                                             |
| Query plan kept whole (JSON `EXPLAIN`, 1.10.0) | 2,000,000 characters; a larger plan is refused (`SQL_LIMITS.maxPlanChars`)                      |
| Plan viewer (browser)                          | 20,000 steps, nesting 100, each text cut at 300 characters (`PLAN_MAX_NODES`, `PLAN_MAX_DEPTH`) |
| Query tabs                                     | 20 (`MAX_TABS`)                                                                                 |

## Statistics (1.10.0)

No numeric limit of its own: one fixed query for one table, with the catalog statement timeout of 15 s. It
reads no row. See [Table details and statistics](/guides/canvas/#table-details-and-statistics).

## Claude reading a connection (MCP, 1.11.0)

Values were checked against the constants in `mcp-service.ts`, `mcp-control.ts`, `mcp-data.ts`,
`mcp/route.ts` and `packages/mcp/src`.

| Limit                                             | Value                                                                                                                                                                                    | Constant or place                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Request body of `/mcp`                            | 256 KB                                                                                                                                                                                   | `MCP_MAX_BODY_BYTES`              |
| Messages in a JSON-RPC batch                      | 20                                                                                                                                                                                       | `MAX_BATCH`                       |
| One answer (text and structure together)          | 200,000 characters; a larger one is refused, not cut                                                                                                                                     | `MAX_RESULT_CHARS`                |
| Calls served                                      | 30 a minute, all connections together                                                                                                                                                    | `CALLS_PER_MINUTE`                |
| Wait for the person's Approve                     | 2 minutes, then "not approved"                                                                                                                                                           | `DEFAULT_APPROVAL_TIMEOUT_MS`     |
| Calls kept in the activity list                   | 200                                                                                                                                                                                      | `MAX_ACTIVITY`                    |
| A request kept in the list and shown for approval | 25,000 characters (longer is refused)                                                                                                                                                    | `REQUEST_CHARS`                   |
| Tables per `list_tables` call                     | 500 (then a cursor of up to 6 digits)                                                                                                                                                    | `LIST_TABLES_PAGE`                |
| `search_objects` results                          | 50; the word 1 to 100 characters                                                                                                                                                         | `SEARCH_RESULTS`                  |
| `read_rows` page                                  | 1 to 100 rows, 50 by default; up to 10 filters; a cursor up to 4,096 characters                                                                                                          | tool schema                       |
| `run_readonly_query` rows                         | 1 to 1,000, 200 by default                                                                                                                                                               | tool schema                       |
| `run_readonly_query` time                         | 1 to 30 s, 10 s by default                                                                                                                                                               | tool schema                       |
| Statement length (both query tools)               | 20,000 characters (the SQL tab itself accepts 200,000)                                                                                                                                   | tool schema                       |
| A cell returned                                   | 500 characters                                                                                                                                                                           | `CELL_CHARS`                      |
| Rows returned in one answer                       | about 100,000 characters of rows (the rows that fit; `truncated: true`)                                                                                                                  | `RESULT_CHARS`                    |
| `explain_query`                                   | `EXPLAIN (FORMAT JSON)`, 1 row, 10 s; the plan is not subject to the 100,000 and 500 limits above, only to the 200,000-character answer limit; its text copy is cut at 20,000 characters | `mcp-service.ts`                  |
| Names and the connection id                       | 1 to 255 characters; the id 1 to 64                                                                                                                                                      | tool schema                       |
| Concurrency                                       | one statement and one page read at a time per connection (`sql_busy`, `rows_busy`)                                                                                                       | the existing runner and gate      |
| The bridge: one line / one call                   | 300,000 characters / 180 s                                                                                                                                                               | `MAX_LINE_CHARS`, `mcp-bridge.ts` |
| Screen polling while shared                       | every 1.5 s                                                                                                                                                                              | `POLL_MS`                         |

The plan (`docs/mcp-server-plan.md`, section 4) gave `read_rows` a maximum of 200 rows and `explain_query` 1 MB;
the code allows 100 rows and the limits above, and this page follows the code.

## Writes, bulk and import

| Limit                           | Value                      | Constant                                           |
| ------------------------------- | -------------------------- | -------------------------------------------------- |
| Lock wait                       | 3 s                        |                                                    |
| Preview lifetime                | 5 minutes                  | `PREVIEW_TTL_MS`                                   |
| Previews per connection         | 20 (2 for imports)         | notes, `MAX_IMPORT_PREVIEWS_PER_CONNECTION`        |
| Grid edit rows                  | 500                        | `MAX_BULK_ROWS`                                    |
| Grid edit cells per row         | 50                         | `EDIT_CELLS_MAX_CELLS_PER_ROW`                     |
| Grid edit cells in total        | 2,500                      | `EDIT_CELLS_MAX_CELLS`                             |
| Matching rows per change        | 100,000                    | Write-side plan, section 6                         |
| Listed failing import rows      | 1,000                      | `VALIDATE_LIST_ALL_MAX_FAILURES`                   |
| Deadline to list failures       | 60 s                       | `VALIDATE_LIST_ALL_TIMEOUT_MS`                     |
| Bulk rows                       | 500                        | `MAX_BULK_ROWS`                                    |
| Import rows                     | 100,000                    | `IMPORT_MAX_ROWS`                                  |
| Import columns                  | 50                         | `IMPORT_MAX_COLUMNS`                               |
| Import cell                     | 10,000 characters          | `IMPORT_MAX_CELL_CHARS`                            |
| Import file                     | 20 MB                      | `IMPORT_MAX_FILE_BYTES`                            |
| Request body (import, validate) | 32 MB                      | `IMPORT_MAX_BODY_BYTES`, `VALIDATE_MAX_BODY_BYTES` |
| Value in a change               | 100,000 characters         | `WRITE_MAX_CHANGE_VALUE_CHARS`                     |
| Columns in one change           | 100                        | `WRITE_MAX_CHANGE_COLUMNS`                         |
| Identifier                      | 63 bytes                   | `WRITE_MAX_IDENTIFIER_BYTES`                       |
| Comment                         | 2,000 characters           | `WRITE_MAX_COMMENT_CHARS`                          |
| Session history                 | 200 entries per connection | notes                                              |
| Validation rows                 | 100,000                    | notes and `CHANGELOG.md` 1.9.0                     |

## Saved data

| Limit                                   | Value  | Constant                                     |
| --------------------------------------- | ------ | -------------------------------------------- |
| Profiles                                | 100    | `MAX_PROFILES`                               |
| Workspaces                              | 500    | `MAX_WORKSPACES`                             |
| Nodes per workspace                     | 2,000  | `MAX_WORKSPACE_NODES`                        |
| Snapshots                               | 100    | `MAX_SNAPSHOTS`                              |
| Tables in a snapshot                    | 5,000  | `MAX_SNAPSHOT_TABLES`                        |
| Objects per kind in a snapshot          | 10,000 | `MAX_SNAPSHOT_OBJECTS_PER_KIND`              |
| Schema check baseline file              | 20 MiB | `MAX_BASELINE_BYTES` in `schema-check.ts`    |
| Imported workspace file (browser check) | 1 MB   | `MAX_IMPORT_BYTES` in `workspace-actions.ts` |

## Other

| Limit                             | Value                                          |
| --------------------------------- | ---------------------------------------------- |
| Default request body              | 64 KB                                          |
| Framework proxy body buffer       | 36 MB (`next.config.ts`)                       |
| JSON tree nodes                   | 5,000 (`TREE_MAX_NODES`)                       |
| Collapsed table columns on canvas | 12                                             |
| Long definitions in snapshots     | cut at 20,000 characters, with a fingerprint   |
| Graceful shutdown                 | about 3 s for the server; 5 s before `SIGKILL` |

---

**Sources:** [`apps/web/lib/server/mcp-service.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/mcp-service.ts),
[`mcp-control.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/mcp-control.ts),
[`mcp-data.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/mcp-data.ts),
[`apps/web/app/mcp/route.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/app/mcp/route.ts),
[`packages/mcp/src/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/packages/mcp/src),
[`packages/cli/src/mcp-bridge.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/cli/src/mcp-bridge.ts),
[`packages/postgres-adapter/src/introspection/export-rows.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/postgres-adapter/src/introspection/export-rows.ts),
[`apps/web/features/sql/plan.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/features/sql/plan.ts), and the constants named above in
[`packages/shared-types/src/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/packages/shared-types/src),
[`packages/database-core/src/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/packages/database-core/src),
[`apps/web/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/apps/web), and
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) for entries marked as notes.
Limits change between releases; check the constant in source before relying on one.
