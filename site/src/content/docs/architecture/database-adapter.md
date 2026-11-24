---
title: Database adapter
description: The DatabaseAdapter contract, how the PostgreSQL adapter reads the catalogs, and the safety properties of every query.
---

## The contract

`packages/database-core/src/adapter.ts` defines the interface every provider implements. One adapter
instance is bound to **one database**. Methods fail only with `DatabaseError`, never a raw driver error.

| Method                                            | Purpose                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `connect()` / `testConnection()` / `disconnect()` | Open and verify (idempotent); verify and keep nothing open; release everything (safe to repeat).              |
| `getSchemas()`, `getTables(schema)`               | User-visible schemas; tables, views, materialized views and foreign tables.                                   |
| `getColumns` / `getConstraints` / `getIndexes`    | Detail of one table.                                                                                          |
| `getTablesDetails(tables)`                        | Description, columns, constraints and indexes for many tables in **four queries**.                            |
| `getRelationships()`                              | Every confirmed foreign key, in one call.                                                                     |
| `getObjects()`                                    | Views, types, sequences, functions, triggers, extensions and policies.                                        |
| `getIndexUsage()`                                 | Index usage counters, when they were reset, and whether the server is a standby.                              |
| `searchObjects(query, limit)`                     | Tables and columns whose name matches.                                                                        |
| `getRows`, `getCell`, `exportRows`                | The **only** methods that return table rows; called only behind the data-access check.                        |
| `validateRows(request)`, `preflight(checks)`      | Database-side checks that write no row (see [Reading table data](/architecture/data-access/)).                |
| `getDdlDetail(tables, schemas)`                   | The parts of a definition a migration needs (identity, generated, deferrable, partitioning, storage options). |
| `getRoleInfo()`                                   | Facts about the connected role, for warnings.                                                                 |

Writing is a **separate interface**, `WritableAdapter` (`describeForEdit`, `previewChange`, `applyChange`),
reached only through the write service. See [Write pipeline](/architecture/write-pipeline/).

Rules every implementation follows:

- It throws only `DatabaseError`. Unknown schema or table is `not_found`; a data call before `connect()` or
  after `disconnect()` is `not_connected`.
- Results are plain, JSON-safe data. "No value" is `null`, never `undefined`.
- There is **no method on `DatabaseAdapter` that runs SQL you wrote**. The SQL tab uses a separate
  capability, `SqlRunnerAdapter`, and changing data is another, `WritableAdapter`.

## Errors

`DatabaseError` carries a stable `code` (`authentication_failed`, `unreachable`, `ssl_error`, `timeout`,
`permission_denied`, `database_not_found`, `not_found`, `not_connected`, `invalid_request`, `not_supported`,
`too_slow`, `unexpected`) and a **safe, fixed message per code**. The original driver error stays in `cause`
for server-side debugging and is not serialised. The registry (`AdapterRegistry`) is generic over a config
map, so each provider keeps its own precise connection type.

## Where the metadata comes from

PostgreSQL describes itself in **system catalogs** (`pg_catalog`), which DataCanvas reads directly:

| Catalog                      | One row per                               | Used for                                                |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `pg_namespace`               | schema                                    | the schema list, hiding `pg_*` and `information_schema` |
| `pg_class`                   | table, view, index, sequence… (`relkind`) | table list and kind                                     |
| `pg_attribute`, `pg_attrdef` | column, default                           | columns, types (`format_type`), nullability, defaults   |
| `pg_description`             | comment                                   | table and column comments                               |
| `pg_constraint`              | constraint                                | primary key, unique, foreign key, check                 |
| `pg_index` + `pg_am`         | index                                     | indexes, key columns, uniqueness, access method         |

Columns are referenced by number (`conkey`, `indkey`), so queries join `pg_attribute` to get names;
`unnest(…) WITH ORDINALITY` keeps order. Relationships are **declared foreign keys only**
(`contype = 'f'`). Cardinality is computed in TypeScript (`deriveCardinality`): a foreign key is one-to-one
when some unique key of the source table consists only of the foreign key's columns; partial, expression and
invalid unique indexes do not count.

## Safety properties

- Every query is a **fixed string with bound parameters**; identifiers and values from callers are never
  concatenated into SQL. Identifiers are quoted with `quoteIdentifier` from `database-core`.
- Every ordinary operation runs in `BEGIN READ ONLY` with a statement timeout (default 15 s). Connecting has
  a 10 s limit, the pool holds at most 3 connections, and idle connections close after 30 s. A test proves an
  `INSERT` is refused.
- Row counts shown in the explorer come from the **planner's statistics**, never from a scan.
- TLS settings are always passed explicitly, so `PGSSLMODE` cannot weaken them; `verify-full` verifies
  certificate and host name.
- Raw driver errors never leave the package (`mapPgError`).
- Foreign tables are a fourth `RelationKind` (`foreign_table`, `relkind = 'f'`), defined once so listing,
  search and existence checks all see them; `components/relation-kind.ts` is the single place the UI names
  and draws each kind (a `Record<RelationKind, …>` so a missing kind is a compile error).

## Testing the contract

| Layer                                                            | Needs a database               | Proves                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Unit tests                                                       | no                             | error mapping, SSL mapping, cardinality rules, row-estimate rules                                                                    |
| Shared **contract suite** (`@datacanvas/database-core/contract`) | mock: no; PostgreSQL: yes      | the mock and the real adapter behave identically                                                                                     |
| PostgreSQL integration tests                                     | yes (`DATACANVAS_TEST_PG_URL`) | real catalogs, partitions, expression/GIN/INCLUDE indexes, composite foreign keys, read-only enforcement, timeouts, real error codes |

`examples/odd-schema.sql` is a deliberately awkward database (names with spaces, capitals, emoji and
SQL-looking text; 63-byte names; the same table name in two schemas; enums, domains, ranges, generated
columns; tables with no columns or 301 columns; circular, deferrable and cross-schema foreign keys;
inheritance; nested partitions; and more) used to pin down adapter behaviour.

---

**Sources:** [`packages/database-core/src/adapter.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/adapter.ts),
[`packages/postgres-adapter/src/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/packages/postgres-adapter/src),
[`packages/postgres-adapter/src/connection/config.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/postgres-adapter/src/connection/config.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Phases 4 and 5, Robustness, Foreign tables),
[`examples/odd-schema.sql`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/examples/odd-schema.sql).
Method names in the table were checked against the interface in `adapter.ts`; see that file for exact signatures.
