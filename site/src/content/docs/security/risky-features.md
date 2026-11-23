---
title: Writes, SQL and migrations
description: How the three features that go beyond reading metadata are kept narrow, and what each one cannot protect you from.
---

Four capabilities go beyond reading metadata: **table rows**, the **SQL tab**, **writes** (with bulk change
and import), and **migrations**. Each is a separate capability behind its own gate.

## Data viewing (rows)

- Per connection, **off by default**. The refusal comes first: `ConnectionService.getRows` checks the
  connection's own `dataAccess` **before it touches the database or even resolves the table**, so a
  switched-off connection cannot be used to learn whether a table exists. It answers `403
data_access_disabled`.
- The request schema is **strict**: there is no `where`, `orderBy`, `limit`, `offset`, `columns` or `sql`
  key. The shape of the query never depends on the caller.
- Hidden (sensitive-looking) columns are not read, and cannot be sorted or filtered until revealed.
- One page read at a time per connection (up to three more wait; further requests get `429 rows_busy`).

## The SQL tab

The one place where text you type becomes SQL, so it is narrow:

- **One statement, read-only**, on a connection opened for that run and closed after, never one of the
  pool. PostgreSQL refuses more than one statement in a text. It cannot write, even with `--enable-writes`.
- The first word must be `SELECT`, `WITH`, `VALUES`, `TABLE`, `EXPLAIN` or `SHOW`, checked the way
  PostgreSQL reads comments and white space. This keeps out what a read-only transaction does not stop
  (`DO`, `COPY … TO PROGRAM`, `CALL`, `SET`, `BEGIN`). `EXPLAIN` is allowed only for a plain query without
  `INTO`.
- Limits on rows, bytes and time; Cancel really cancels in the database.
- **Masking does not apply** and **the role is the control**: a superuser, or a role that may run programs
  or read files on the database server, can do that from a `SELECT`. The tab warns for such a role.
- Nothing is kept: statements, results and history are browser-tab memory only.

## Writes

Three independent switches, **checked on every call** in `write-service.ts` (the only place that touches the
write capability):

1. The process was started with `--enable-writes` (the CLI passes `DATACANVAS_ENABLE_WRITES=1` only when
   given, and deletes any inherited value; the server treats only the exact value `"1"` as on).
2. The connection's host is loopback (`localhost`, `127.0.0.0/8`, `::1`; not `0.0.0.0` or a LAN address).
3. The person unlocked that connection by typing its database name. The unlock lives in the registry
   entry, in memory only; it is cleared by disconnect, by switching data viewing off, and by a restart.

The refusals come in a fixed order (`writes_not_enabled`, `writes_not_allowed_here`,
`data_access_disabled`, `wrong_database_name`, then `write_not_unlocked`) and none echoes what was typed.

Further properties:

- **A change is a structured operation, never SQL.** There is no field for an expression, a WHERE clause,
  `USING` or a check; a rule test fails if a request schema grows a key named `sql`, `where`,
  `expression` or `using`.
- **Preview, then apply exactly that**: single-use, bound to its connection, five minutes, at most 20 per
  connection (2 for imports), cleared on lock and disconnect. The browser never gets the parameters.
- **Plan guard**: a plan that names existing tables records the catalog object id and column positions, and
  `applyChange` refuses it if a table was dropped and recreated since.
- **No `CASCADE`** anywhere (a source rule checks).
- **Errors never carry a value**: fixed sentences by SQLSTATE; tests plant a distinctive value and assert it
  is absent from the message, response and history.
- Bulk changes are **many single-row changes in one transaction**, each of which must change exactly one
  row or everything rolls back. An import's file is parsed in the browser; names in the file are never SQL.

**What "on this machine" cannot prove:** the host is what you typed, and an SSH tunnel or the Cloud SQL
Auth Proxy looks local while pointing at a remote database. The unlock dialog shows the address the server
reports and a red **Writes on** badge stays visible, but neither is proof.

## Migrations

The Migrations tab writes SQL as **text** and runs none of it: there is no route to apply a script, no
connection of its own, and it is built in your browser from the structure of the two sides.

- **The text is the risk.** A script is made from names and definitions read from a database, which may be
  hostile. Every name goes through identifier quoting and every literal through string quoting; definitions
  PostgreSQL printed are used as printed; comments are cut to one line (at carriage returns as well as line
  feeds); held SQL is written as comments line by line. Tested with names made of quotes, line breaks, `;`,
  `--`, `/*`, `$$`, emoji and 63-byte names, by running the result on a real PostgreSQL.
- **Run what you have read.** A migration contains view and function text; running it runs that text.
- **Runner commands.** A dbmate or goose file is refused when a name or text holds a line that the runner
  would obey (`-- migrate:`, `-- +goose`).
- **Pre-flight** (Check against the data) runs four fixed read-only counts built from catalog-checked names;
  it never runs a constraint's text.

## Your role warnings

DataCanvas warns, and never blocks, when the role you connected with can do more than the task needs: while
browsing, a role that can change data or create objects; with writes unlocked, a superuser, a role that can
create roles or databases, bypass row-level security or reach the server's files (read from one catalog
query, `getRoleInfo`).

---

**Sources:** [`SECURITY.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/SECURITY.md),
[`docs/threat-model.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/threat-model.md) (sections 7 to 11b),
[`apps/web/lib/server/write-service.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/write-service.ts),
[`apps/web/lib/server/sql-service.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/sql-service.ts),
[`packages/database-core/src/sql-run.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/database-core/src/sql-run.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Editing rows and designing tables, data viewer M2).
