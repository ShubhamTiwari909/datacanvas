# Security and privacy

DataCanvas is a local tool: it runs on your computer, talks to your database from your computer, and sends nothing anywhere else. This page says exactly what that means, and what it does not.

> DataCanvas has not had an independent security review. Nothing here is a guarantee that it is "completely secure". Please read the limits at the end.

## What stays on your machine

| Thing                         | Where it lives                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database password             | In memory of the running server only. Never written to disk, never returned by the API, never logged.                                                  |
| Host, port, database, user    | In `~/.datacanvas/connections.json` only if you choose **Save connection**, together with whether data viewing is on. Not the password.                |
| Table rows (if you view data) | In the memory of the server for the length of one request, and in your browser's memory while a table's Data section is open. Never written to a file. |
| Canvas layouts                | `~/.datacanvas/workspaces/` (table names and positions). Files are owner-only (mode 0600).                                                             |
| Session token (while running) | In the server's memory and in `~/.datacanvas/run.json` (owner-only) so a second launch can reopen it. Deleted on exit.                                 |
| What leaves the machine       | Nothing. No account, no cloud, no analytics. Telemetry of the web framework is switched off at start-up.                                               |

Set `DATACANVAS_HOME` to use a different folder.

## What DataCanvas reads from your database

By default, only **metadata**: schema, table and column names, types, keys, indexes, constraints, comments, definitions of views, functions and policies, usage counters and row-count estimates. Every query runs in a read-only transaction, and there is no way to run your own SQL.

If you switch on **data viewing** for a connection (off by default, shown by a badge, remembered with the saved connection), DataCanvas also reads **rows**: a `SELECT` on a table you open, in the same read-only transaction, with limits on rows, columns, cell length, response size and time. It has a small set of fixed shapes: a sort and up to three conditions are structured choices from the screen (a column, a fixed operator, a value), never text you write, and every value is sent to the database as a parameter, so there is still no way to run your own SQL. A sort or a condition on a hidden column is refused until you reveal it, because it would reveal the column one question at a time. Rows go from the database to the local server to your browser and nowhere else; they are never written to a file, logged, cached, or included in an error message, a snapshot or a workspace. Columns whose names look sensitive (`password`, `token`, `secret`, ...) are not sent unless you reveal them; this is a convenience, not a security control, because names are only a hint. Anyone who holds the session token can switch data viewing on, so treat the printed link like a password.

## How the local server is protected

A web page you visit can try to reach programs listening on `127.0.0.1`. DataCanvas defends against that in layers:

1. It listens on `127.0.0.1` only, never on your network.
2. **Host check** (blocks "DNS rebinding"): only `127.0.0.1:<port>` and `localhost:<port>` are accepted.
3. **Origin check**: state-changing requests from another web page are refused. The browser's `Sec-Fetch-Site` hint must say same-origin.
4. **Session token**: every start creates a new random secret. The link printed by `datacanvas` carries it once; the app swaps it for an `HttpOnly`, `SameSite=Strict` cookie and removes it from the address bar. Requests without it are refused. Treat the printed link like a password while DataCanvas runs.
5. The checks run in the front door (`proxy.ts`) **and** again inside every API route.
6. No CORS headers are ever sent, so other sites cannot read responses. Responses forbid framing and referrers.

## What to do for your database

- Use a **read-only database user** with the least access that is useful.
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
- Two DataCanvas processes sharing one data folder are not coordinated.

The full reasoning is in [docs/threat-model.md](docs/threat-model.md).

## Reporting a problem

Please report vulnerabilities privately through GitHub's private vulnerability reporting on this repository (the **Security** tab, then **Report a vulnerability**), and do not open a public issue with exploit details.
