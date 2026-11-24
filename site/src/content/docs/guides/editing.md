---
title: Editing rows and tables
description: The three switches that must all be on before DataCanvas can change a database, and how row edits, table creation and structure changes work through previews.
---

:::caution
Changes are **committed immediately and cannot be undone** by DataCanvas. Use this only on a database you
are willing to change, with a role that can do only what you need.
:::

DataCanvas does not change your database unless you ask for it **three times**.

## The three switches

1. **Start it with `--enable-writes`**, for example
   `npx --yes @shubhamtiwari909/datacanvas --enable-writes`. A notice is printed at every start with the
   flag. Without the flag, nothing in the app or the API can change a database. An environment variable
   does not count.
2. **Use a database on this machine.** Writes are offered only when the host is `localhost`, an address in
   `127.0.0.0/8`, or `::1`. Any other connection stays read-only.
3. **Unlock writes for the connection.** Use the **Writes** switch beside it in the left list and type
   the **database name**. Viewing table data must be on. The dialog shows the address the database server
   reports and any warning about your role. A red **Writes on** badge is shown while unlocked; **Lock
   writes** ends it, and so do disconnecting, reconnecting and stopping DataCanvas. The unlock is never
   saved.

:::note[Tunnels look local]
An SSH tunnel (`ssh -L`) or a proxy such as the Cloud SQL Auth Proxy also listens on `127.0.0.1` but
forwards to another server, possibly production, so it looks local. DataCanvas cannot tell. Check the
address in the unlock dialog and unlock only a database you are willing to change.
:::

The SQL tab stays **read-only** even with writes on. Changes are made through forms that show the exact
statement first.

## Editing a row

In a table's **Data** section: choose a cell or the row's **Edit** button, type the new values (NULL and
an empty value are separate choices) and **Preview**. **Add row** opens a form with every column: give a
value, NULL, or leave it to its default. Generated columns and `GENERATED ALWAYS` identities cannot be
set. **Delete** removes one row.

A table needs a primary key, or a unique index that is **not partial**, covers plain columns (no
expressions) and has only `NOT NULL` columns, to be edited. Views, materialized views and foreign tables
cannot be edited. Long values cut in the grid, hidden columns and `bytea` columns cannot be edited, and the
grid says why.

## Creating and changing tables

- **New table** (beside a schema): columns with a type from a fixed list (numbers, text, dates and times,
  `uuid`, `json`, `jsonb`, `bytea`, `inet`, and arrays of these), nullability, a default from a fixed list
  (a value, the current time or date, a random UUID, true or false) or an identity, a primary key, unique
  columns, foreign keys to existing tables, and comments.
- **Edit structure** (in the table's details): add, rename and drop columns; rename and drop the table;
  change a column's type (only where PostgreSQL can convert it on its own); set or drop NOT NULL and a
  default; add a primary key, unique constraint or foreign key; drop a constraint; create or drop an
  index.
- A **drop** needs the table name typed, and is **refused**, with a list of what depends on it, while a
  view, a foreign key or an index uses it. DataCanvas never emits `CASCADE`.

## Preview, then apply exactly that

Every change opens a **preview** first:

- the exact statement that will run (values appear as `$1`, `$2`, … and you can copy it);
- the values before and after;
- what to know before applying: triggers that will run, foreign keys from other tables and what they do,
  row-level security, and whether the change locks or rewrites the table.

Deleting and dropping need a tick to confirm. **Apply** runs exactly the statement you saw, in **one
transaction**. A preview can be applied **once** and expires after **five minutes**.

- An update is refused if a column you are changing **no longer holds the value you saw**; other columns
  are not compared, so two people changing different columns of one row do not conflict. A delete is by
  key and compares no values.
- Each row statement must change **exactly one row**, or the transaction rolls back.
- A change waits at most **3 seconds** for a lock. Once it has the lock, a long `ALTER TABLE` (a type
  change rewrites the table) blocks other queries on that table until it finishes; the preview says when
  that applies.
- Database errors are shown as a **fixed sentence** (for example "A row with the same value already
  exists"), never with your values in them.

## Session history

**Changes** (from the badge) lists what you changed in this session: the kind of change, the table, the
column names, the time and the outcome, and the statement for structure changes (left out when it holds a
default value or a comment you typed). It never shows row values and is **not saved**. A structure
change history can also be read as a migration script (`GET /api/connections/:id/writes/migration`).

---

**Sources:** [`docs/getting-started.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/getting-started.md) (section 5),
[`SECURITY.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/SECURITY.md),
[`apps/web/features/writes/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/apps/web/features/writes),
[`apps/web/lib/server/write-service.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/write-service.ts),
[`packages/cli/src/index.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/cli/src/index.ts).
Internals: [Write pipeline](/architecture/write-pipeline/).
