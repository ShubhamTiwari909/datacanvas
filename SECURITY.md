# Security and privacy

DataCanvas is a local tool: it runs on your computer, talks to your database from your computer, and sends nothing anywhere else. This page says exactly what that means, and what it does not.

> DataCanvas has not had an independent security review. Nothing here is a guarantee that it is "completely secure". Please read the limits at the end.

## What stays on your machine

| Thing                         | Where it lives                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database password             | In memory of the running server only. Never written to disk, never returned by the API, never logged.                                                                                                                                                                                                           |
| Host, port, database, user    | In `~/.datacanvas/connections.json` only if you choose **Save connection**, together with whether data viewing is on. Not the password.                                                                                                                                                                         |
| Table rows (if you view data) | In the memory of the server for the length of one request, and in your browser's memory while a table's Data section is open. Never written to a file by DataCanvas: the one exception is a file you ask for with **Export**, which your browser saves on your computer and DataCanvas keeps nothing of.        |
| SQL you type, and its results | In your browser tab's memory (the text, the results, the history of statements) and, for one request, in the server's. Never written to a file or logged by DataCanvas. A CSV file or a copy to the clipboard of a result is something you make yourself; save a query as a `.sql` file if you want to keep it. |
| A change you preview (writes) | The planned statement and its values in the server's memory for at most five minutes, until it is applied or dropped. Never written to a file or logged.                                                                                                                                                        |
| The list of changes made      | In the server's memory for the session: the kind of change, the table, the column names, the time and the outcome (and the statement for a change of structure, left out when it carries a default value or a comment you typed). Never row values, never a file.                                               |
| Canvas layouts                | `~/.datacanvas/workspaces/` (table names and positions). Files are owner-only (mode 0600).                                                                                                                                                                                                                      |
| Session token (while running) | In the server's memory and in `~/.datacanvas/run.json` (owner-only) so a second launch can reopen it. Deleted on exit.                                                                                                                                                                                          |
| What leaves the machine       | Nothing. No account, no cloud, no analytics. Telemetry of the web framework is switched off at start-up.                                                                                                                                                                                                        |

Set `DATACANVAS_HOME` to use a different folder.

## What DataCanvas reads from your database

By default, only **metadata**: schema, table and column names, types, keys, indexes, constraints, comments, definitions of views, functions and policies, usage counters and row-count estimates. Every query runs in a read-only transaction, and SQL you write runs only in the SQL tab (below).

If you switch on **data viewing** for a connection (off by default, shown by a badge, remembered with the saved connection), DataCanvas also reads **rows**: a `SELECT` on a table you open, in the same read-only transaction, with limits on rows, columns, cell length, response size and time. It has a small set of fixed shapes: a sort and up to three conditions are structured choices from the screen (a column, a fixed operator, a value), never text you write, and every value is sent to the database as a parameter, so the Data tab itself never runs SQL you write. A sort or a condition on a hidden column is refused until you reveal it, because it would reveal the column one question at a time. Rows go from the database to the local server to your browser and nowhere else; they are never written to a file by DataCanvas, logged, cached, or included in an error message, a snapshot or a workspace (a result you save from the SQL tab, below, is a file you make yourself). Columns whose names look sensitive (`password`, `token`, `secret`, ...) are not sent unless you reveal them; this is a convenience, not a security control, because names are only a hint. Anyone who holds the session token can switch data viewing on, so treat the printed link like a password.

## When DataCanvas changes your database

Never by default. Changing rows or structure (1.4.0) needs **all three** of:

1. DataCanvas was **started with `--enable-writes`**. The switch is a command-line flag, not something the app or the API can turn on, so a web page or a program that gets hold of the session token still cannot enable it. An environment variable in your shell does not count either; only the flag does. DataCanvas prints a notice at every start with the flag.
2. The connection is to a database **on this machine**: its host is `localhost`, an address in `127.0.0.0/8` or `::1`. Everything else stays read-only.
3. You **unlock writes for that connection** by typing its database name. The unlock is kept in memory only, is never saved with the connection, and ends when you disconnect, reconnect or stop DataCanvas. Viewing table data must also be on.

Even then the SQL tab stays read-only, and a change is a structured operation (a table, a key, a column and a value; or a column definition from fixed lists of types and defaults), the server builds the statement from names checked against the catalog, and every value is sent as a parameter. You see the exact statement before it runs; applying runs exactly that statement, in one transaction, with a 3 second limit on waiting for a lock. A row change must change exactly one row. An update is refused if a column you changed no longer holds the value you saw; other columns are not compared, so two people changing different columns of one row do not conflict, and a delete is by key and compares no values. DataCanvas itself never uses `CASCADE`: a drop is refused while a view, a foreign key or an index depends on it. A foreign key that already cascades or sets NULL still does so when you delete a row, and the preview names it. A database error never reaches the screen as is (it can contain a value); you get a fixed sentence that may name a constraint or a column.

## The SQL tab (1.6.0)

Off unless **data viewing** is on for the connection (a result is rows). It is the one place where text you type becomes SQL, so it is narrow:

- **One statement, read-only.** The statement runs in a read-only transaction on a connection opened for that run and closed after it, never one of the pool, so it cannot change what a later write does. PostgreSQL refuses more than one statement in a text. It cannot write, even when DataCanvas was started with `--enable-writes`.
- **What it starts with.** The first word must be `SELECT`, `WITH`, `VALUES`, `TABLE`, `EXPLAIN` or `SHOW`, checked the way PostgreSQL reads comments and white space. This keeps out what a read-only transaction does not stop (`DO`, `COPY ... TO PROGRAM`, `CALL`, `SET`, `BEGIN`), and `EXPLAIN` is allowed only for a plain query without the word `INTO`, because PostgreSQL runs `EXPLAIN ANALYZE CREATE TABLE ... AS` without its read-only check.
- **Limits.** 1,000 rows by default (10,000 at most), read in small batches and stopped at 64 MB, a 30 second time limit (5 minutes at most), one statement at a time per connection, and Cancel really cancels it in the database. A single very large value is still read whole before it is cut, so a statement that returns half a gigabyte in one cell can use that much memory.
- **Masking does not apply.** A query can rename or compute any column, so hiding columns by name cannot work here. It shows what the connected role can read; **the role is the control**.
- **Your database role matters most here.** A read-only transaction stops every write, but not what a function can do outside the database. A superuser, or a role that may run programs or read files on the database server, can do that from a `SELECT`. The SQL tab says so above the editor for such a role. Use a read-only role for SQL you did not write yourself.
- **Nothing is kept.** Statements, results and the history live in memory in your browser tab and are gone when you close the page or disconnect; nothing about them is written to a file, logged, or put in an error of ours. A database error about your statement (its sentence and the position) is shown to you, as the answer to what you typed. Save a tab as a `.sql` file if you want to keep it. A result copied or saved as CSV, TSV or JSON is a file of your rows; a value a spreadsheet would run as a formula is saved with a leading apostrophe.
- **Completion** uses the names of your database that the app already reads (tables, columns, functions), kept in memory. Nothing is sent anywhere for it, and the editor is built into the package: it loads nothing from another host.

**What "on this machine" cannot prove.** The host is what you typed. An SSH tunnel (`ssh -L`) or the Cloud SQL Auth Proxy listens on `127.0.0.1` and forwards to a remote, possibly production, database, so such a connection looks local. The unlock dialog shows the address the database server reports and asks you to make sure it is not production, and a red **Writes on** badge stays visible while writes are unlocked, but neither is proof. A committed change cannot be undone.

**Your database role.** DataCanvas warns when the role you connected with can do more than the task needs: when browsing, a role that can change data or create objects; with writes unlocked, a superuser or a role that can create roles or databases, bypass row-level security or reach the server's files. The warning never blocks you.

## Migrations (1.7.0)

The **Migrations** tab writes SQL as **text** and runs none of it: there is no new route, no connection of its own and no way to apply a script from DataCanvas. It is built in your browser from the structure of the two sides (a snapshot or a live read of the structure), so it holds no rows and saves nothing.

- **The text is the risk.** A script is made from names and definitions read from a database, which may be hostile. Every name goes through identifier quoting and every literal through string quoting (a backslash becomes an `E''` string); definitions PostgreSQL printed (`pg_get_constraintdef`, `pg_get_viewdef`, `pg_get_functiondef`) are used as printed. Comments are cut to one line, at carriage returns as well as line feeds. Held (unconfirmed destructive) SQL is written as comments line by line. Tested with names made of quotes, line breaks, `;`, `--`, `/*`, `$$`, emoji and 63-byte names, by running the result on a real PostgreSQL.
- **Run what you have read.** A migration contains the **text of views and functions** read from the databases it compares, and running it runs that text. A function or view in a database you do not control can do anything its definition says. Each file says so at the top.
- **Formats.** A dbmate or goose file is refused when a name or text in the migration holds a line that the runner would obey (`-- migrate:`, `-- +goose`). Flyway reads `${...}` as a placeholder; a file with that text says so.
- **What it does not know.** It compares structure, not data, owners, grants, partitioning, storage options, view options or the position of a sequence, and says so in every migration. A rename is only ever applied when you confirm it, and the text of functions is not rewritten for one.
- **Destructive changes** (drops, a column type that loses data) are flagged, and each needs its own confirmation before it is more than a comment. A rollback cannot bring back rows that a drop removed.

## How the local server is protected

A web page you visit can try to reach programs listening on `127.0.0.1`. DataCanvas defends against that in layers:

1. It listens on `127.0.0.1` only, never on your network.
2. **Host check** (blocks "DNS rebinding"): only `127.0.0.1:<port>` and `localhost:<port>` are accepted.
3. **Origin check**: state-changing requests from another web page are refused. The browser's `Sec-Fetch-Site` hint must say same-origin.
4. **Session token**: every start creates a new random secret. The link printed by `datacanvas` carries it once; the app swaps it for an `HttpOnly`, `SameSite=Strict` cookie and removes it from the address bar. Requests without it are refused. Treat the printed link like a password while DataCanvas runs.
5. The checks run in the front door (`proxy.ts`) **and** again inside every API route.
6. No CORS headers are ever sent, so other sites cannot read responses. Responses forbid framing and referrers.

## What to do for your database

- Use a **read-only database user** with the least access that is useful. If you edit with DataCanvas, use a role that can change only the tables you mean to change, on a local development database.
- Use **TLS with certificate verification** when the database is not on your own machine.
- DataCanvas sets connection and statement timeouts and limits the size of everything it reads.

## Validation, the pre-flight and export

These three read table data, so they need **data viewing** on, like the page of rows.

- **Validate** (the edit and add-row forms) asks whether the database would accept the values, without writing a row. The values go into a temporary copy of the table (its types, NOT NULL, CHECK and generated columns, with no triggers, foreign keys, defaults or indexes) in a transaction that is switched to read-only before the first value goes in and is always rolled back, so a rule of the table that tries to change data fails instead. Uniqueness and foreign keys are asked by read-only queries on the real tables. The answer holds rule names, column and constraint names, counts and row numbers, never a value. It needs the right to create temporary tables, and says what it did not check (triggers, row-level security, partial and expression unique indexes).
- **Check against the data** (Migrations) runs four fixed read-only counts built from names that are looked up in the database's catalog. It does not run the text of a check constraint or try a type conversion: that text can come from a snapshot file.
- **Export** writes the rows you are looking at, with the filter and sort on screen, as a file: up to 100,000 rows and 64 MB, then a line that says it was cut. Columns whose names look sensitive are left out unless you showed them, and the file names them. A value a spreadsheet would run as a formula gets a leading apostrophe. One export runs at a time per connection, and closing the dialog stops the read in the database. The file is made on your machine from rows you could already see, and DataCanvas keeps nothing of it.
- The **JSON editor** reads one `json` or `jsonb` value whole (up to 1 million characters) by its row's key, behind the same check as a page of rows, and writes nothing: a changed value goes through the same preview and apply as any edit.

## Before you export a diagram

A PNG, SVG or workspace file shows **table and column names**. That can reveal how a system works. It contains no row data, whether or not data viewing is on, and is created on your machine, but share it only with people who should see your schema.

The Data section is not exported or saved. If you share your screen, a screenshot or a recording while it is open, rows are visible; the **Blur values** switch hides them on screen, but it is for that purpose only and does not change what is read.

## Known limits

- Another program running as **your user** can read the process list and so the token. DataCanvas does not defend against an attacker who already has your account.
- The token travels over plain `http` on loopback. Other users on a shared machine cannot normally see loopback traffic, but this is not hardened against a hostile administrator.
- Cookies are not isolated by port; other web apps on `127.0.0.1` receive the cookie. The Origin and `Sec-Fetch-Site` checks stop them from using it from a browser.
- There is no full Content-Security-Policy yet (the framework inlines scripts; this needs nonces).
- Passwords live in memory, so they are present in a memory dump of the process. So are the rows of any page you have open, in the server and in your browser, and they can end up in the operating system's swap.
- Hiding columns by name is a hint, not a control. A column called `notes` can hold a password; one called `token_count` is harmless. Use a database user that cannot read what DataCanvas should not show.
- Browser extensions with access to the page can read what the page shows, including rows.
- Row-level security can silently return fewer rows; the Data section says so only when it applies to your database user.
- A sort or a condition can make the database scan a whole table. Such reads are stopped after 5 seconds, one runs at a time per connection, and the page says so, but each try can still cost the database up to 5 seconds of work. Use a database user with the limits you want.
- A condition's value is held in memory and sent in a request body; like the rows, it is never saved, logged, or put in an error message.
- With writes unlocked, anyone holding the session token can change that local database. Lock writes, or start DataCanvas without `--enable-writes`, when you are done.
- A tunnel or proxy on `127.0.0.1` to a remote database counts as local (see above).
- The SQL tab runs what a role is allowed to run: a function with effects outside the database (through an extension such as `dblink`, or a privileged role) is not stopped by a read-only transaction. A statement can also change its own time limits for the rest of its transaction, which only matters to the few queries we run after it. A pooler such as PgBouncer can make Cancel reach the wrong session; use a direct connection for SQL you may need to cancel.
- A change can wait up to 3 seconds for a lock; once it has the lock, a long `ALTER TABLE` (a type change rewrites the table) blocks every other query on that table until it finishes. The preview says when a change takes such a lock or rewrites the table.
- A file you export is yours: DataCanvas cannot protect it after your browser saved it. A column whose name does not look sensitive can still hold a secret, and an export includes it. Export from a database user that cannot read what must not leave.
- Validation does not run row triggers or check row-level security, but it is not free of side effects: **event triggers** fire when its temporary copy is made, before the read-only switch, so one can write or advance a sequence; and a function in a CHECK that has effects outside the database (through an extension such as `dblink`) is not stopped by a read-only transaction or undone by the rollback. The role you connect with is the control.
- Triggers on a table run when you change a row, and can do anything their code does. The preview names them.
- A destructive step you leave unconfirmed is written commented out, and so is every later step that needs it or is about the same object, with the reason. Steps that only touch other things still run: confirm or leave out steps together.
- A migration is as good as the structure it was made from. A structure read while another migration runs can mix before and after, and a migration made from an old snapshot may not fit the database it is run on: read it first, and run it in a test copy when you can.
- Two DataCanvas processes sharing one data folder are not coordinated.

The full reasoning is in [docs/threat-model.md](docs/threat-model.md).

## Reporting a problem

Please report vulnerabilities privately through GitHub's private vulnerability reporting on this repository (the **Security** tab, then **Report a vulnerability**), and do not open a public issue with exploit details.
