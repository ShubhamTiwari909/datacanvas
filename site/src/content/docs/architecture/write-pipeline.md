---
title: Write pipeline
description: How a change flows from a structured operation through preview and apply, with the three gates, the plan guard, and error mapping.
---

Writing is the **only** feature that changes a database. It is a separate capability that is off unless three
independent switches are on (see [Writes, SQL and migrations](/security/risky-features/)).

## The flow

```text
UI form ──▶ Change (structured operation, never SQL)
              │  strict Zod schema (shared-types/src/writes.ts), mirrored by database-core/src/changes.ts
              ▼
POST …/writes/preview ──▶ WriteService.preview
              │  three gates in fixed order
              │  adapter.previewChange(change)     ← READ ONLY transaction: checks the catalog,
              │                                      builds statements, effect sentence, warnings
              ▼
        PreviewStore keeps the plan + parameters (single use, 5 min, per connection)
              │  browser gets statement text with $1,$2… and NOT the parameters
              ▼
POST …/writes/apply { previewId } ──▶ WriteService.apply
              │  take the plan (removes it first), one write at a time per connection
              │  adapter.applyChange(plan)
              ▼
        withWriteTransaction: BEGIN → locks + plan guard → statements → COMMIT / ROLLBACK
```

## Changes are data

- **Row changes**: `update_row`, `insert_row`, `delete_row`. **Structure changes**: `create_table` and
  fourteen alter operations.
- Values are **lists of `{ column, value }`**, not objects keyed by column, so a column named `__proto__` is
  just a name. Every value is text, cast by the database to the column's own type; `null` is NULL.
- Types come from a fixed list; a default is one of a fixed set (none, a literal cast to the column type,
  `now()`, `current_date`, `gen_random_uuid()` where it exists, a boolean, an identity). There is no field for
  an expression, `WHERE`, `USING` or check; a rule test fails if a request schema grows such a key.
- Bulk changes are _N single-row changes_ in one transaction; an import is batches of one fixed
  `INSERT … SELECT CAST(…) FROM unnest(…)`.

## The adapter side

`postgres-adapter/src/connection/write.ts` provides `withWriteTransaction`, the only `BEGIN` that is not
read-only:

- its own pool client for the whole transaction;
- `lock_timeout` 3 s and a `statement_timeout` (15 s for a row change, 60 s for a structure change), both set
  with `set_config(…, true)` so they stay local to the transaction;
- a plain `BEGIN`, not `BEGIN READ WRITE`, so a database that is read-only by default stays read-only;
- a client whose rollback fails is destroyed.

Row statements find the row by its key (the primary key or a qualifying unique index). An update only runs if
each changed column **still holds the value the person saw**
(`CAST(col AS text) IS NOT DISTINCT FROM CAST($n AS text)`), and each row statement must report **exactly one
row** or the transaction rolls back (`row_changed` for none). SET and VALUES cast to the column type without
its length, so the assignment enforces the length instead of truncating. Generated columns, `GENERATED ALWAYS`
identities and `bytea` cannot be set. A type change needs an implicit or assignment cast in `pg_cast`. Drops are
refused, naming dependents, while a view, foreign key or index uses the thing; there is **no `CASCADE`** in
any statement.

## The plan guard

A plan that names existing tables carries a guard: the catalog object id of each such table and the column
positions it uses. `applyChange` takes a lock on each table and checks the guard **before any statement**, so
a plan made for a table that was since dropped and recreated is refused. A `create_table` plan has none (its
table does not exist yet), and a changed default or NULL setting is not detected, while a changed type, length
or precision is (decision 139).

## Errors carry no value

`connection/write-errors.ts` maps SQLSTATE to fixed sentences (`unique_violation`, `foreign_key_violation`,
`not_null_violation`, `check_violation`, `invalid_value`, `locked`, `retry`, `write_denied`,
`has_dependents`, `already_exists`, `row_changed`, …). A sentence may name a constraint, table or column and
never a value or the database's message. Tests plant a distinctive value and assert it is absent from the
message, `toJSON`, the response and the history.

## History and the role check

`WriteService.history` keeps 200 entries per connection in memory (kind, table, column names, time, outcome,
and the statement for structure changes unless it carries typed text). `getRoleInfo` (`role-info.ts`) reads one
catalog query (superuser, role and database creation, `BYPASSRLS`, predefined roles, `CREATE` rights, a capped
count of writable tables, the address the server reports) and `roleWarnings` in the core turns it into read-mode
and write-mode warnings that never block.

## UI

The sidebar `WritesControl` appears only when the process was started with writes. In the Data section
`useRowEditing` adds Edit, Delete and Add row; every action goes through one `ChangeDialog` (statement, before
and after, warnings, a tick for destructive changes, then Apply). The table builder and alter dialogs build the
same structured changes. The browser-side calls are named `requestPreview` and `requestApply` so the rule
"only the write service reaches the write capability" can match the adapter's `previewChange` and
`applyChange` by name. A structure counter makes the schema tree, search lists, details and canvas metadata
reload after a create, rename or drop.

## Routes

All under `/api/connections/:id/`: `GET writes`, `POST writes/unlock`, `POST writes/lock`,
`POST writes/edit-info`, `POST writes/preview` (1 MB body limit in `docs/architecture.md`, later raised for
imports), `POST writes/apply`, `GET writes/history`, `GET writes/migration`, and `GET role`. See the
[HTTP API reference](/reference/api/).

---

**Sources:** [`apps/web/lib/server/write-service.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/write-service.ts),
[`apps/web/lib/server/preview-store.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/preview-store.ts),
[`packages/postgres-adapter/src/connection/write.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/postgres-adapter/src/connection/write.ts),
[`packages/postgres-adapter/src/connection/write-errors.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/postgres-adapter/src/connection/write-errors.ts),
[`packages/database-core/src/changes.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/changes.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Editing rows and designing tables),
[`docs/data-editing-plan.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/data-editing-plan.md).
The "fourteen alter operations" and statement-timeout figures come from `docs/architecture.md` and were not recounted in source.
