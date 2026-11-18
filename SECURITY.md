# Security and privacy

DataCanvas is a local tool: it runs on your computer, talks to your database from your computer, and sends nothing anywhere else. This page says exactly what that means, and what it does not.

> DataCanvas has not had an independent security review. Nothing here is a guarantee that it is "completely secure". Please read the limits at the end.

## What stays on your machine

| Thing                         | Where it lives                                                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database password             | In memory of the running server only. Never written to disk, never returned by the API, never logged.                                                                                                                                                             |
| Host, port, database, user    | In `~/.datacanvas/connections.json` only if you choose **Save connection**, together with whether data viewing is on. Not the password.                                                                                                                           |
| Table rows (if you view data) | In the memory of the server for the length of one request, and in your browser's memory while a table's Data section is open. Never written to a file.                                                                                                            |
| A change you preview (writes) | The planned statement and its values in the server's memory for at most five minutes, until it is applied or dropped. Never written to a file or logged.                                                                                                          |
| The list of changes made      | In the server's memory for the session: the kind of change, the table, the column names, the time and the outcome (and the statement for a change of structure, left out when it carries a default value or a comment you typed). Never row values, never a file. |
| Canvas layouts                | `~/.datacanvas/workspaces/` (table names and positions). Files are owner-only (mode 0600).                                                                                                                                                                        |
| Session token (while running) | In the server's memory and in `~/.datacanvas/run.json` (owner-only) so a second launch can reopen it. Deleted on exit.                                                                                                                                            |
| What leaves the machine       | Nothing. No account, no cloud, no analytics. Telemetry of the web framework is switched off at start-up.                                                                                                                                                          |

Set `DATACANVAS_HOME` to use a different folder.

## What DataCanvas reads from your database

By default, only **metadata**: schema, table and column names, types, keys, indexes, constraints, comments, definitions of views, functions and policies, usage counters and row-count estimates. Every query runs in a read-only transaction, and there is no way to run your own SQL.

If you switch on **data viewing** for a connection (off by default, shown by a badge, remembered with the saved connection), DataCanvas also reads **rows**: a `SELECT` on a table you open, in the same read-only transaction, with limits on rows, columns, cell length, response size and time. It has a small set of fixed shapes: a sort and up to three conditions are structured choices from the screen (a column, a fixed operator, a value), never text you write, and every value is sent to the database as a parameter, so there is still no way to run your own SQL. A sort or a condition on a hidden column is refused until you reveal it, because it would reveal the column one question at a time. Rows go from the database to the local server to your browser and nowhere else; they are never written to a file, logged, cached, or included in an error message, a snapshot or a workspace. Columns whose names look sensitive (`password`, `token`, `secret`, ...) are not sent unless you reveal them; this is a convenience, not a security control, because names are only a hint. Anyone who holds the session token can switch data viewing on, so treat the printed link like a password.

## When DataCanvas changes your database

Never by default. Changing rows or structure (1.4.0) needs **all three** of:

1. DataCanvas was **started with `--enable-writes`**. The switch is a command-line flag, not something the app or the API can turn on, so a web page or a program that gets hold of the session token still cannot enable it. An environment variable in your shell does not count either; only the flag does. DataCanvas prints a notice at every start with the flag.
2. The connection is to a database **on this machine**: its host is `localhost`, an address in `127.0.0.0/8` or `::1`. Everything else stays read-only.
3. You **unlock writes for that connection** by typing its database name. The unlock is kept in memory only, is never saved with the connection, and ends when you disconnect, reconnect or stop DataCanvas. Viewing table data must also be on.

Even then there is no way to run your own SQL. A change is a structured operation (a table, a key, a column and a value; or a column definition from fixed lists of types and defaults), the server builds the statement from names checked against the catalog, and every value is sent as a parameter. You see the exact statement before it runs; applying runs exactly that statement, in one transaction, with a 3 second limit on waiting for a lock. A row change must change exactly one row. An update is refused if a column you changed no longer holds the value you saw; other columns are not compared, so two people changing different columns of one row do not conflict, and a delete is by key and compares no values. DataCanvas itself never uses `CASCADE`: a drop is refused while a view, a foreign key or an index depends on it. A foreign key that already cascades or sets NULL still does so when you delete a row, and the preview names it. A database error never reaches the screen as is (it can contain a value); you get a fixed sentence that may name a constraint or a column.

**What "on this machine" cannot prove.** The host is what you typed. An SSH tunnel (`ssh -L`) or the Cloud SQL Auth Proxy listens on `127.0.0.1` and forwards to a remote, possibly production, database, so such a connection looks local. The unlock dialog shows the address the database server reports and asks you to make sure it is not production, and a red **Writes on** badge stays visible while writes are unlocked, but neither is proof. A committed change cannot be undone.

**Your database role.** DataCanvas warns when the role you connected with can do more than the task needs: when browsing, a role that can change data or create objects; with writes unlocked, a superuser or a role that can create roles or databases, bypass row-level security or reach the server's files. The warning never blocks you.

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
- A change can wait up to 3 seconds for a lock; once it has the lock, a long `ALTER TABLE` (a type change rewrites the table) blocks every other query on that table until it finishes. The preview says when a change takes such a lock or rewrites the table.
- Triggers on a table run when you change a row, and can do anything their code does. The preview names them.
- Two DataCanvas processes sharing one data folder are not coordinated.

The full reasoning is in [docs/threat-model.md](docs/threat-model.md).

## Reporting a problem

Please report vulnerabilities privately through GitHub's private vulnerability reporting on this repository (the **Security** tab, then **Report a vulnerability**), and do not open a public issue with exploit details.
