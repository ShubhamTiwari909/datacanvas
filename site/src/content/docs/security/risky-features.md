---
title: Writes, SQL, migrations and Claude
description: How the features that go beyond reading metadata are kept narrow, what each one cannot protect you from, and what changes when Claude reads a connection.
---

Five capabilities go beyond reading metadata: **table rows**, the **SQL tab**, **writes** (with bulk change
and import), **migrations**, and, since 1.11.0, **letting Claude read a connection**. Each is a separate
capability behind its own gate. Four smaller 1.10.0 features that write to no database are summarised
last.

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

## Statistics, documentation files, chosen rows, INSERT scripts and plans (1.10.0)

None of these writes to a database.

- **Statistics** (the table details) come from the server's own figures. **No row and no value is read:**
  the statistics that hold values of the table (the most common values, the histograms) are never selected,
  and a test fails if any statement names one. They need no "Allow viewing table data", like the row-count
  estimate. A column's null share and distinct count are metadata, but they say something about the data.
- **Export documentation** is made in your browser from names, types, keys and indexes (the Markdown file
  and DBML also carry defaults, check rules and comments, which can hold a literal). No row is read and
  nothing is uploaded. Every name is quoted for its format so a name cannot become syntax. The names can
  reveal how your system works: check where you paste a text diagram.
- **Export chosen rows** reads the rows you chose again on the server, each by the table's **whole key** (up
  to 500), with the same rules as any export: a hidden column is left out, the data-access check comes
  first. A key column that looks sensitive and was not shown, a table without a key and a key that is not the
  table's key are refused. The notes of the file say how many rows were chosen, never their keys.
- **A script of INSERT statements** is text you run yourself: every value a quoted text literal, every name
  quoted, in one transaction. A cut script ends with `ROLLBACK;`, a failed one has no `COMMIT;`, so a half
  script commits nothing. Run it in a test copy first.
- **The query plan viewer** reads the plan of your own statement (JSON) as untrusted text with limits (2 MB,
  20,000 steps, 100 levels), shows it in the tab and keeps it nowhere.

## Letting Claude read a connection (1.11.0)

**Off until you press Share with Claude** under a connection. A Claude app you already use (Claude Desktop,
Claude Code, any MCP client) asks DataCanvas, on your machine, for things to read, and DataCanvas answers.
Nothing in it writes to a database, to a file or anywhere else: there are **fifteen tools** and a test pins the
list; none changes anything. Guide: [Use DataCanvas from Claude](/guides/use-with-claude/). Design:
[MCP server](/architecture/mcp/).

:::danger[What Claude reads is sent to Anthropic]
DataCanvas holds no API key and calls no cloud service. But **whatever Claude reads is sent to Anthropic by
the Claude app, and DataCanvas cannot stop that or take it back.** Share only what may leave your machine,
and connect with a database user that cannot read the rest. This is the purpose of the feature, not a
control that can be tightened.
:::

**Two levels**, chosen per connection and kept **in memory only** (never saved with a profile, a workspace
or a snapshot; gone on a restart, on a disconnect, and when viewing table data is switched off):

- **Structure**: schema, table and column names, types, keys, indexes, foreign keys in both directions and
  the server's statistics. No row of any table. (**Inference from the code:** the structure tools also
  return column defaults, column and table comments and constraint definitions such as CHECK text, which can
  hold a literal, and a hidden column's name and type are listed; only its values are withheld.)
- **Structure and data**: also pages of rows and read-only queries. It needs **Allow viewing table data**,
  and the share dialog needs a tick that rows are sent to Anthropic by the Claude app.

**The controls**

- **You approve each data call** (on by default; you can turn it off in the dialog). The call shows what
  Claude asked (a statement, or a table) and nothing runs until you press **Approve**. Escape and a click
  outside do not answer it; after **two minutes** it is refused.
- **Pause** refuses every call at once (structure tools too) and denies the waiting approvals.
- **At most 30 calls a minute** are served, for all connections together.
- **A list of what Claude asked** (the last 200 calls) shows the request and how it ended, with counts,
  never a value that came back. It is memory only and ends with the sharing.
- **Claude cannot approve or pause itself.** Sharing, the level, Approve, Deny and Pause are `/api` routes
  behind the browser's cookie, which the token of `/mcp` is not. A rule test checks that nothing on the MCP
  path can reach them.
- **Reads only.** Statements run through the SQL tab's runner (a read-only transaction on a connection of
  its own, one statement, the first-word list, the row and time limits); pages go through the page reader
  that already hides sensitive-named columns. `EXPLAIN` is never run with `ANALYZE`. Tested against a real
  database with `DELETE`, `INSERT`, `CREATE`, two statements and `EXPLAIN ANALYZE CREATE TABLE AS`.
- **A database's own error text is not passed on**, because it can hold a value (`invalid input syntax for
type integer: "..."` repeats the text of a row, and a query can make it do so for any column). Only
  errors about names (SQLSTATE class 42), time limits (57014), server limits (class 54) and DataCanvas's own
  refusals are put into words; any other is "The database refused the statement (SQLSTATE …)".
- **A powerful role needs a second yes.** A superuser, or a role in `pg_read_server_files`,
  `pg_write_server_files` or `pg_execute_server_program`, can do outside a read-only transaction what the
  transaction does not stop. Sharing the data level with one is refused (`409
claude_role_not_acknowledged`) until you confirm **Share anyway**. Use a read-only database user instead.
  The structure level needs no confirmation.
- **A connection that is not shared looks like one that does not exist**: one sentence for "not shared",
  "paused" and "no such connection". Every tool is listed at every level (a Claude app reads the list once,
  when it connects); a data tool on a connection that is not at the data level refuses, with nothing run.

**Residual risks, said plainly**

- **Hidden columns are a safety net, not a barrier.** A column whose name looks sensitive is left out of
  pages, never sorted or filtered on, NULL in a result, and a statement that names one is refused. A model
  that is told to can get around it: a **whole-row value** (`row_to_json(t)`, `t::text`), renaming the columns
  of a table (`FROM t AS x(a, b, c)`), a view that renames a column, a name that is not on the list. The
  statistics catalogs (`pg_stats`, `pg_statistic`), `pg_stat_activity` and functions with an effect outside
  the data (`pg_notify`, advisory locks, `dblink`, large objects) are refused. **The control is the database
  user.**
- **An app that can run commands can approve for itself.** Claude Code runs commands as you and can read the
  session link DataCanvas keeps in your data folder, which is enough to call the routes that approve, pause
  and share. Approval protects against mistakes and against a model that has only the tools DataCanvas
  offers, not against an app with a shell.
- **A statement still runs with some effects of a read-only transaction**: it can sleep up to its time limit
  and holds the one statement slot that the SQL tab also uses. Pause and Stop cancel it.
- **Prompt injection.** A value in a table can say anything, and a model may read it as an instruction.
  Claude has only read tools and you can approve each data call, but a model that is led astray can still
  ask for rows, and the Claude app sends them on. Read what you approve. A model that also has another tool
  in the same client (a web fetch, a file write) could pass what it read somewhere else; that is outside
  DataCanvas.
- **Another program running as you** can read `mcp.json` (mode `0600`) and so use the door, once a
  connection is shared. The same trust as `run.json`; the activity list shows every call. It cannot approve
  its own calls or change the sharing.
- **A heavy query** can still cost the database up to its time limit; the limits, one statement at a time
  per connection, the rate limit and the approval bound it.
- **Nothing here can be undone after the fact:** what Claude read was sent on.

## Your role warnings

DataCanvas warns, and never blocks, when the role you connected with can do more than the task needs: while
browsing, a role that can change data or create objects; with writes unlocked, a superuser, a role that can
create roles or databases, bypass row-level security or reach the server's files (read from one catalog
query, `getRoleInfo`).

---

**Sources:** [`SECURITY.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/SECURITY.md),
[`docs/threat-model.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/threat-model.md) (sections 7 to 13),
[`apps/web/lib/server/mcp-service.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/mcp-service.ts),
[`apps/web/lib/server/mcp-control.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/mcp-control.ts),
[`apps/web/lib/server/mcp-data.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/mcp-data.ts),
[`docs/mcp-server-plan.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/mcp-server-plan.md) (sections 8 and 17 to 21),
[`apps/web/lib/server/write-service.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/write-service.ts),
[`apps/web/lib/server/sql-service.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/apps/web/lib/server/sql-service.ts),
[`packages/database-core/src/sql-run.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/database-core/src/sql-run.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Editing rows and designing tables, data viewer M2).
