---
title: Migrations
description: Generate the SQL that makes one database or snapshot look like another, with rollback and a risk label on every step. DataCanvas writes the text and never runs it.
---

:::caution
DataCanvas **never runs** a migration. It produces text. A migration contains the **text of views and
functions** read from the databases it compares, and running it runs that text, so read it first.
:::

Open the **Migrations** tab, or finish a comparison in **Snapshots** and press **Generate a migration
from this comparison**.

## Generate

Choose **From** and **To** (a snapshot, or the live database of any connection, so staging against
production works) and press **Generate migration**. The result makes _From_ look like _To_. **Swap**
reverses it.

- **The summary** says how many steps there are, what they risk (take a lock, rewrite a table, can fail
  on existing rows, destroy data) and how much of it a rollback can undo.
- **Steps** are in the order they run, each with badges, one sentence, and its SQL (up and down) one
  click away. **Untick** a step to leave it out; the steps that need it go with it, and the screen says
  so. Changing an option starts the choices again.
- **Destructive steps** (a dropped table, column, view, function, and a type change that loses data) are
  written **commented out** until you confirm that step. Every later step that depends on an unconfirmed
  one, or touches the same object, is also held, with the reason.
- **Possible renames** are offered with the evidence (a table that is gone and one that is new with the
  same columns; a column of the same type in the same place). A comparison cannot tell a rename from a
  drop and an add: **a rename keeps the rows, a drop and an add does not**, so nothing is renamed until
  you tick it. The text of functions is not rewritten for a rename.
- **Options:** create indexes **without blocking writes** (`CREATE INDEX CONCURRENTLY`, which cannot run
  in a transaction), and add checks and foreign keys **unvalidated**, then validate.
- **The text** has the script, the rollback, and notes: what needs a person, and what was not compared.

## What is covered

Tables, columns, constraints, indexes, foreign keys, views, types, sequences, functions, triggers,
policies, row-level-security switches, schemas, extensions, unlogged tables and storage options
(`fillfactor` and similar), in an order that runs. The rollback is the steps in reverse.

**Not compared** (every migration says so): owners and grants, partitioning, inheritance and tablespaces
(a warning names each table that has them), views' options, the position of a sequence, and row data.
Things PostgreSQL cannot do are a warning and no step: removing or reordering an enum label, changing a
domain's checks or base type, changing the kind of a type. Some things cannot be undone (a dropped table's
rows, a new enum label), and the rollback says which.

## Export

| Format                  | Notes                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| Plain SQL               | For `psql -v ON_ERROR_STOP=1 -f`; carries its own `BEGIN` and `COMMIT`. |
| dbmate or goose         | One file with the runner's markers.                                     |
| Flyway                  | A pair of files.                                                        |
| `up.sql` and `down.sql` | Two files.                                                              |

A step that cannot run in a transaction is written outside it, in its place, with a comment saying why.
Each file begins with what it compares and a reminder to read it. A **format is refused** when a name or
text in the migration would be read by that runner as one of its own commands (`-- migrate:`,
`-- +goose`); Flyway reads `${...}` as a placeholder, and a file with that text says so.

## Check against the data

With a **live database as From**, **Check against the data** says how many rows would make a step fail,
before you run the script:

- NULLs before `SET NOT NULL`;
- shared values before a unique or primary key;
- rows with no parent before a foreign key;
- rows at all before a required column with no default.

It reads only counts and needs **Allow viewing table data**. It does **not** try CHECK constraints or
type conversions (their text can come from a snapshot file), so the script is not fully verified against
your data; try those in the SQL tab. See [Migration engine](/architecture/migration-engine/).

---

**Sources:** [`packages/database-core/src/migration/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/packages/database-core/src/migration),
[`apps/web/features/migrations/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/apps/web/features/migrations),
[`docs/getting-started.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/getting-started.md) (section 7),
[`CHANGELOG.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/CHANGELOG.md) (1.7.0, 1.7.1, 1.8.0), [`SECURITY.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/SECURITY.md).
