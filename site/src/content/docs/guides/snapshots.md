---
title: Snapshots and compare
description: Save the structure of a database, compare any two sides, export the report, and hand the comparison to the migration generator.
---

A **snapshot** is a copy of a database's **structure** at one moment. It never contains rows (whether or
not data viewing is on) and never contains credentials.

## Take, compare, export

- **Take snapshot** reads the database and keeps the result under a name. At most **100** snapshots are
  kept.
- **Compare** takes any two sides, each either a saved snapshot or the **live database of any open
  connection**, so two different databases (staging against production) can be compared.
- The result counts what was added, removed and changed, and lists each table with its column,
  constraint, index and foreign-key changes, plus changes to views, types, sequences, functions,
  triggers, extensions and policies. A changed view query or function body is shown before and after;
  a function is told apart by its name **and arguments**.
- **Copy as Markdown** produces a report for a review or ticket.
- **Export** saves a snapshot as a `<name>.snapshot.json` file; **Import file** loads one as a _new_
  snapshot.
- **Generate a migration from this comparison** opens the [Migrations tab](/guides/migrations/).

## How things are matched

Tables are matched by `schema.name`; columns, constraints and indexes by name; foreign keys by (source
table, constraint name). Column **position is ignored**: dropping an early column renumbers the others,
which is not a change to them. Row-count estimates are left out of a snapshot because they change with
every vacuum and would make an unchanged database look different.

There is **no rename detection** in the comparison: a renamed table or column appears as one removed
and one added. (The [migration generator](/guides/migrations/) can _suggest_ renames, and applies only
ones you confirm.)

## Things to know

- **Older snapshots.** A snapshot from before objects were recorded has no objects (`null`, which is
  different from "none"). The comparison then does **not** compare objects, and the screen and the
  Markdown report say so, rather than reporting every function as new.
- **Not atomic.** A snapshot is read in several steps (schemas, tables, details, foreign keys, objects),
  so one taken while a migration is running can mix before and after states. Take it again when the
  database is quiet.
- **An exported snapshot can contain secrets.** The file lists table and column names and copies view
  queries and function bodies as written, so it can contain anything someone typed into them (a key, a
  password). Treat it like the schema itself and look before you share it.
- A database with more than **5,000 tables** is refused (`snapshot_too_large`).

---

**Sources:** [`packages/database-core/src/structure.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/structure.ts),
[`packages/database-core/src/diff.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/diff.ts),
[`apps/web/features/snapshots/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/apps/web/features/snapshots),
[`docs/getting-started.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/getting-started.md),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Schema snapshots and diff).
See also [Snapshots and diff](/architecture/snapshots-and-diff/).
