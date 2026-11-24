---
title: Reading table data
description: "How rows are read safely: the data-access gate, the fixed statement shapes, paging, sorting, filtering, export, one-cell reads, validation and the SQL runner."
---

Rows are the most sensitive thing DataCanvas touches, so reading them is built as a set of narrow, gated
capabilities.

## The gate

`ConnectionService.getRows` checks the connection's own `dataAccess` flag **before it touches the database
or resolves the table**, answering `403 data_access_disabled` with a fixed message. It is the only place an
adapter's `getRows` is called for the browser; `getCell`, `validateRows`, `preflight` and `exportRows` follow
the same rule. Rule tests in `tests/security.test.ts` fail if another file calls them or the refusal moves
after the adapter is used.

`dataAccess` is a boolean on the connection summary, **off unless asked for**, set at connect time or later
through `PUT /api/connections/:id/data-access`, and remembered with a saved connection. The saved-connections
file was bumped to version 2 for this, and the 1→2 migration gives every existing profile `dataAccess: false`
so an upgrade never makes anything readable. Switching it saves the profile **first** and the in-memory
setting second, so a disk failure changes nothing.

`RowsGate` lets one read run per connection with up to three waiting; more get `429 rows_busy`.

## One fixed statement

`buildRowsQuery` (a pure function with exact-text tests) produces one statement of a small written family:

```sql
SELECT 1 AS r, left(CAST("col" AS text), $1) AS c0, …, CAST("key" AS text) AS k0
FROM "schema"."table"
[WHERE …] [ORDER BY …] LIMIT $n [OFFSET $m]
```

- Identifiers come from the catalog and are quoted by `quoteIdentifier`; aliases are **positions**, so no
  column name becomes an alias; page size and cursor are bound parameters. Nothing from the caller becomes
  SQL text.
- **Values are text, cut in the database**: `CAST(col AS text)` removes driver type surprises and
  `left(…, 2001)` cuts a long value before it travels (flagged `truncated`). `CAST(boolean AS text)` is
  `true`/`false`. SQL NULL stays `null`.
- **Which key orders and pages the table**: the primary key, else a unique index that is valid, live, over
  plain columns, not partial, with every key column `NOT NULL` (the narrowest wins). A materialized view is
  read unordered. Without a key, paging is by position down to 10,000 rows (`offsetCapped`).
- The key is selected **a second time, untruncated**, because the paging cursor must hold the real key.
- The cursor is plain ASCII, untrusted (bounded, strictly shaped, used only as bound parameters), so a forged
  cursor can only move where the page starts.
- No value in an error: PostgreSQL's message for a bad value contains the value, so SQLSTATE class 22 becomes
  `invalid_request` with a fixed message.

The request schema is **strict**: no `where`, `orderBy`, `limit`, `offset`, `columns` or `sql` key exists.

## Sort and filter

`RowsOptions.sort` (one column, direction) and `RowsOptions.filters` (up to ten conditions, optionally in
groups) are structured. The operator's SQL comes from a table keyed by its name, the column is a quoted
catalog name and the value is a bound parameter; `contains` and `starts with` avoid `LIKE` so no value holds a
wildcard. `filterOpsFor(kind, dataType)` says which operators a column allows (text, ordered, `json`,
`array`, other). A hidden column, a column that was not read, or an operator the kind does not allow is
refused with a fixed message. A sorted or filtered read has a **5 second** limit; cancellation is the
`too_slow` code (HTTP 422). A generated test enforces the statement grammar.

## Export

`exportRows` streams the rows as filtered and sorted on screen, a batch at a time, through the page reader's
own statement and checks in the read-only transaction, up to 100,000 rows and 64 MB, then ends with a note
that it was cut. Formatters in `database-core/src/rows-export.ts` (CSV, TSV, JSON, NDJSON, SQL) are shared and
tested (a fifth format, `sql`, is the INSERT script, 1.10.0); they make spreadsheet formulas safe with a leading apostrophe and put nothing about a value in the
notes. Batches are sized by what they hold, one export runs at a time per connection (`export_busy`), and a
client that goes away ends the database read. If it fails after the first byte the stream ends with a fixed
sentence rather than the database's message.

### Chosen rows and the INSERT script (1.10.0)

- **Chosen rows.** The export request may carry `keys`: up to **500** rows, each by the table's **whole key**
  (each key part a column name and a text value of at most 4,096 characters, up to 32 parts). The adapter
  checks them against the table's real key (`checkKeys`): a key that is not the table's key, a table without a
  key, or a key column that is hidden and not revealed is refused. The keys go into the same read statement
  (the page reader's, every value bound), so the rows are **read again on the server** and not taken from the
  grid. The body of such a request may be up to **4 MB** (`EXPORT_MAX_BODY_BYTES`) with at most 1,000,000
  characters of key values (`EXPORT_MAX_KEY_CHARS`), because 500 rows with a composite uuid key exceeded the
  default 64 KB.
- **Reading settings.** After the cursor is declared the transaction sets `DateStyle = ISO, MDY`,
  `IntervalStyle = postgres`, `extra_float_digits = 3` and `bytea_output = hex` (local to the transaction), so
  the text of every value is the same whoever reads the file. They are set after the cursor so the keys and
  conditions copied from the grid are still read in the session's own `DateStyle`.
- **The script** (`sql` format): `BEGIN;`, `SET LOCAL standard_conforming_strings`, `datestyle` and
  `intervalstyle`, then `INSERT` statements of 100 rows (every value a quoted text literal, a quote doubled;
  every identifier quoted; generated columns left out; `OVERRIDING SYSTEM VALUE` for identity-always
  columns), then `COMMIT;`. A cut script, or one made with sensitive-named columns left out, ends with
  `ROLLBACK;`; a failure after the first byte leaves no end at all. A round trip against a real PostgreSQL
  with hostile values is part of the tests.

## One cell

`getCell` reads **one** `json` or `jsonb` value whole (up to 1 million characters) by the row's **whole key**
from the catalog, with every value bound, behind the same gate. A hidden column cannot be the target.

## Validation

`validateRows` checks values in a **temporary copy** of the table without triggers, foreign keys, defaults or
indexes. The transaction starts read-write only because `CREATE TEMP TABLE` is refused in a read-only one; the
only statements before the switch are the `CREATE TEMP TABLE … (LIKE …)` and `ALTER` of that table, built from
catalog names. Then `SET TRANSACTION READ ONLY` runs **before any value is inserted** (a temporary table can
still be written; everything else cannot), and it **always rolls back**. Uniqueness and foreign keys are asked
by read-only queries on the real tables. The `ValidationReport` holds rule, column and constraint names,
counts and row numbers, never a value. Accepted risks (documented in the threat model): event triggers fire
at the temporary-table creation, and an effect outside the transaction (a `dblink` write from a CHECK
function) is not undone.

## Migration pre-flight

`preflight(checks)` runs four fixed read-only counts (NULLs, duplicates for a unique key, orphans for a foreign
key, rows at all) built from catalog-checked names. A check is a **structure**, never text; a CHECK constraint
and a narrowing type change are deliberately not run.

## The SQL runner

A separate capability, `SqlRunnerAdapter`, reached only by `sql-service.ts` through exactly **one route**
(`POST /api/connections/:id/run`; since 1.11.0 the MCP service also calls `SqlService.run` for Claude's
`run_readonly_query` and `explain_query`, which adds no new way to run SQL): strict body, no GET, `no-store`, nothing logged. It opens a **connection of
its own** for each run (so a `SET SESSION default_transaction_read_only = off` cannot touch a pooled
connection used later by a write), uses the **extended protocol** with a named statement (the server refuses
more than one command in it, where the simple protocol would let `SELECT 1; COMMIT; DROP TABLE x` end the
read-only transaction), checks the first word, and applies limits (see [Limits](/reference/limits/)). The
client going away cancels the statement in the database.

**Plans (1.10.0).** `EXPLAIN (FORMAT JSON)` answers one row of one cell, which is the one result whose cell
must not be cut (a plan cut in the middle is not JSON): `isWholePlan` keeps it whole up to
`SQL_LIMITS.maxPlanChars` = 2,000,000 characters, and a larger plan is refused with a sentence. The browser
reads it as untrusted text (`features/sql/plan.ts`: at most 20,000 nodes and nesting 100, every number checked,
every string cut at 300 characters, nothing used as markup).

## Statistics

`getTableStatistics` (1.10.0, `postgres-adapter/src/introspection/statistics.ts`, route
`GET /api/connections/:id/tables/:table/statistics`) reads, with one fixed query, the share of NULLs, the
distinct count, the width and the correlation of each column (`pg_stats`) and the sizes and upkeep times of
the table. **No row and no value is read**: the columns of `pg_stats` that hold values (`most_common_vals`, the
histograms) are never selected, the column list is written out, and a test fails if any statement of the
adapter names one. It needs no data-access check, like the row-count estimate; `statistics` is null for a view
or a foreign table. `pg_stats` shows a column only to a role that may select it and only once the table was
analysed.

## Where rows may live in the browser

Rows live only in component state (`useRows`): never in a Zustand store, `localStorage`, `sessionStorage`,
`indexedDB`, cookies or caches. Rule tests scan `features/data` for those APIs, and for `console.` calls.

---

**Sources:** [`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Reading table rows, M1 to M4, S1 to S3),
[`packages/database-core/src/rows.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/rows.ts),
[`packages/postgres-adapter/src/introspection/statistics.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/postgres-adapter/src/introspection/statistics.ts),
[`packages/postgres-adapter/src/introspection/export-rows.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/postgres-adapter/src/introspection/export-rows.ts),
[`packages/database-core/src/rows-export.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/rows-export.ts),
[`packages/database-core/src/validation.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/validation.ts),
[`packages/postgres-adapter/src/connection/checking-transaction.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/postgres-adapter/src/connection/checking-transaction.ts),
[`packages/postgres-adapter/src/connection/run-statement.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/postgres-adapter/src/connection/run-statement.ts),
[`tests/security.test.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/tests/security.test.ts).
The SQL statement shape is quoted from `docs/architecture.md`; the current 1.8.0 filter grammar adds the extra operators
and groups, so treat the exact text as illustrative.
