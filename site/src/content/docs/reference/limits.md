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

100,000 rows, 64 MB, one export at a time per connection.

## SQL tab

| Limit        | Value                           |
| ------------ | ------------------------------- |
| Statement    | 200,000 characters              |
| Rows         | 1,000 default, 10,000 maximum   |
| Result bytes | 64 MB read                      |
| Cell         | 2,000 characters                |
| Time         | 30 s default, 5 minutes maximum |
| Lock wait    | 3 s                             |

## Writes, bulk and import

| Limit                           | Value                      | Constant                                           |
| ------------------------------- | -------------------------- | -------------------------------------------------- |
| Lock wait                       | 3 s                        |                                                    |
| Preview lifetime                | 5 minutes                  | `PREVIEW_TTL_MS`                                   |
| Previews per connection         | 20 (2 for imports)         | notes, `MAX_IMPORT_PREVIEWS_PER_CONNECTION`        |
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

**Sources:** the constants named above in
[`packages/shared-types/src/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/packages/shared-types/src),
[`packages/database-core/src/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/packages/database-core/src),
[`apps/web/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web), and
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) for entries marked as notes.
Limits change between releases; check the constant in source before relying on one.
