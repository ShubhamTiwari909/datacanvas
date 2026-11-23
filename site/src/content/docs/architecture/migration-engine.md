---
title: Migration engine
description: How a migration is planned from two structures, ordered, risk-labelled, held when destructive, exported for common runners, and pre-checked against data.
---

The engine lives in `packages/database-core/src/migration/` and is **pure**: it takes structures and choices
and returns a plan and text. It reads no clock, touches no database and writes nothing. It runs **in the
browser**; there is no server route to apply a script.

## Pipeline

```text
from, to  (DatabaseStructure each)
   │
   ├─ rename.ts     suggestRenames(from, to)  → candidates with evidence
   │                applyRenames(…)           → ALTER … RENAME steps for the ones a person confirmed,
   │                                            and `from` rewritten as PostgreSQL would have it
   ▼
planMigration (plan.ts) → ordered steps, each with reverse + risk
   │      uses  classify.ts (column type change cost/risk)  ·  objects.ts (everything around tables)
   ▼
script.ts   which steps are in · which destructive steps are confirmed · script + rollback text
   ▼
export.ts   plain SQL · dbmate/goose · Flyway pair · up.sql + down.sql
   ▼
preflight.ts   how many existing rows would make a step fail (counts only)
```

## Ordering

The up script runs in this order, and the down script is the same steps in reverse so a table that was
dropped is back before the foreign key that pointed at it:

1. drop the foreign keys that go, change, or hang on a key or column that does;
2. drop the other constraints and the indexes that go or change;
3. drop the tables that go;
4. create the new tables (columns only);
5. change the columns of the tables that stay (drop, add, alter);
6. add the constraints and create the indexes of the new and changed;
7. add the foreign keys **last**, so two tables that point at each other work.

`objects.ts` plans the objects around the tables in three groups placed around the table steps: **dropFirst**
(triggers, policies and views that go or must be made again, dependents first; sequences that must let go of a
table or column that goes), **foundations** (schemas, extensions, types, sequences, functions a table does not
wait on) and **last** (sequence owners, functions, views by dependency, comments, triggers, policies, row
security; then what goes). Nothing is matched by position or guess, and no statement contains `CASCADE`. What
PostgreSQL cannot do (removing or reordering an enum label, changing a domain's checks or base type, changing
a type's kind) is a **warning and no step**.

## Risk and classification

Each step carries risk flags (takes a lock, rewrites the table, can fail on existing rows, destroys data, cannot
be undone). `classify.ts` decides for a column type change which conversions round or cut values (destructive),
which can fail on rows that exist, which rewrite the table, and whether PostgreSQL needs a `USING` expression,
working on the text `format_type` prints (`"numeric(10,2)"`, `"timestamp(3) with time zone"`).

## Holding and omitting steps

`script.ts` takes the ids of steps the person **left out** (anything that depends on them goes too, and the
screen says so) and of destructive steps the person **confirmed**. Unconfirmed destructive SQL is written
**commented out**, line by line, cut at every kind of line break; a held step also holds later steps that need
it or are about the same object. Every line of non-SQL text goes through `flattenComment`, because names can
hold line breaks and PostgreSQL ends a `--` comment at a carriage return as well as a line feed.

## SQL text

`sql.ts` builds the text of each piece. Every name goes through `quoteIdentifier` and every literal through
`quoteString`; definitions PostgreSQL printed (`pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_expr`,
`pg_get_viewdef`, `pg_get_functiondef`) are used as printed. **The text is never run here.**

## Export formats and transactions

`export.ts` is a pure function of the plan, the picks, a name and a moment. A file for `psql` carries its own
`BEGIN` and `COMMIT`. A step PostgreSQL cannot run in a transaction (`CREATE INDEX CONCURRENTLY`, a new enum
label that may then be used) is written **outside** it, in its place, with a comment. A runner (dbmate, goose,
Flyway) wraps a migration itself, so its file carries no `BEGIN` unless it has such a step, in which case it
asks the runner for no transaction and keeps its own around the rest. A file whose runner reads comment lines
as commands (`-- migrate:`, `-- +goose`) is **refused** if the migration holds such a line, since no quoting
would stop the runner obeying it.

A different, smaller thing shares the word "migration": `apps/web/lib/server/migration-file.ts` turns the
**structure changes you applied through writes in this session** into one SQL script that repeats them on
another database (`GET /api/connections/:id/writes/migration`). It is pure text building, counts row changes
without keeping their values, and flattens every name that goes into a comment to one line.

## DDL detail

Early structures recorded names, types and defaults only. `ddl.ts` adds a **sparse** record of what `CREATE`
and `ALTER` need: identity and generated columns, collations, deferrable and not-yet-validated constraints,
partitioned, inheriting, unlogged and storage-option tables. A structure that never recorded it has
`ddl: null`, and the planner says which parts it could not plan, as the comparison does for objects.

## Pre-flight

For steps marked "can fail on existing rows", `preflight.ts` makes a **structure** of checks (a table, columns,
the columns a foreign key points at) and the adapter checks every name against the catalog of the database it
asks, building one fixed query per kind. Four kinds: `SET NOT NULL` (rows holding NULL), unique or primary key
(groups sharing a value; a key with a NULL never collides), foreign key (rows without a parent) and required
column (rows at all). A CHECK constraint and a narrowing type change are **not** checked, because that would
mean running text that may have come from a file.

## Verification

The adapter package has round-trip tests that run generated migrations on a real PostgreSQL
(`migration.round-trip`, `migration-objects.round-trip`, `migration-renames.round-trip`,
`migration-export.round-trip`, `migration-review.round-trip`) and a property test
(`migration.property.test.ts`, which reads `DATACANVAS_PROPERTY_RUNS` and `DATACANVAS_PROPERTY_SEED`). See
[Testing](/contributing/testing/).

---

**Sources:** [`packages/database-core/src/migration/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/packages/database-core/src/migration)
(file headers of `plan.ts`, `classify.ts`, `rename.ts`, `objects.ts`, `script.ts`, `sql.ts`, `export.ts`, `preflight.ts`),
[`packages/database-core/src/ddl.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/database-core/src/ddl.ts),
[`apps/web/lib/server/migration-file.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/migration-file.ts) (session script only),
[`docs/migration-studio-plan.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/migration-studio-plan.md),
[`packages/postgres-adapter/src/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/packages/postgres-adapter/src) (round-trip tests).
The pipeline diagram is a summary (**Inference**) of the module headers; the property-test environment variables come from a
source search and their semantics were not read in detail.
