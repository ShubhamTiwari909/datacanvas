---
title: What is stored and read
description: Where each kind of data lives, how long it lives there, and exactly what DataCanvas reads from your database.
---

## What stays on your machine

| Thing                         | Where it lives                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database password             | In memory of the running server only. Never written to disk, never returned by the API, never logged.                                                                                                                                                                                                                     |
| Host, port, database, user    | In `~/.datacanvas/connections.json` only if you choose **Save connection**, together with whether data viewing is on. Not the password.                                                                                                                                                                                   |
| Table rows (if you view data) | In the server's memory for the length of one request, and in your browser's memory while a table's Data section is open. Never written to a file by DataCanvas. The one exception is a file you ask for with **Export**, which your browser saves and DataCanvas keeps nothing of.                                        |
| SQL you type, and its results | In your browser tab's memory (text, results, history) and, for one request, the server's. Never written to a file or logged. A CSV you save or a copy to the clipboard is yours; save a query as `.sql` to keep it.                                                                                                       |
| A change you preview (writes) | The planned statement and its values in the server's memory for at most five minutes, until applied or dropped. Never written to a file or logged.                                                                                                                                                                        |
| An import you preview         | The file's rows in your browser while the dialog is open, and in the server's memory with the planned statements for at most five minutes. The file itself is never sent, saved or logged; the server never parses it.                                                                                                    |
| The list of changes made      | The server's memory for the session: kind, table, column names, time and outcome (and the statement for a structure change, left out when it carries a default value or comment you typed). Never row values.                                                                                                             |
| Canvas layouts                | `~/.datacanvas/workspaces/` (table names and positions), owner-only.                                                                                                                                                                                                                                                      |
| Snapshots                     | `~/.datacanvas/snapshots/`: structure only. No rows, no credentials.                                                                                                                                                                                                                                                      |
| Session token (while running) | The server's memory and `~/.datacanvas/run.json` (owner-only) so a second launch can reopen it. Deleted on exit.                                                                                                                                                                                                          |
| Share with Claude (1.11.0)    | The level per connection, the approval choice, the pause, the pending approvals and the list of what Claude asked (the last 200 calls; the request and counts, never a returned value): **server memory only**, gone on a restart, a disconnect or when sharing stops. Never saved with a profile, workspace or snapshot. |
| MCP token (while running)     | The server's memory and `~/.datacanvas/mcp.json` (owner-only, `0600`, holds only the process id, the port and the token) so the bridge `datacanvas mcp` can find it. Deleted on exit. A different secret from the session token.                                                                                          |
| What leaves the machine       | **Nothing, unless you share a connection with Claude (1.11.0).** DataCanvas has no account, no cloud service, no analytics and holds no API key. What a Claude app reads through the shared connection is sent to Anthropic **by the Claude app**, and DataCanvas cannot stop that or take it back.                       |

Set `DATACANVAS_HOME` to use a different folder.

## What DataCanvas reads from your database

**By default, only metadata:** schema, table and column names, types, keys, indexes, constraints,
comments, definitions of views, functions and policies, usage counters and row-count estimates. Every
query runs in a read-only transaction.

With **data viewing** on for a connection (off by default, shown by a badge, remembered with the saved
connection) DataCanvas also reads **rows**: a `SELECT` on a table you open, in the same read-only
transaction, with limits on rows, columns, cell length, response size and time.

- The Data section has a **small set of fixed statement shapes**. A sort and the filter conditions are
  structured choices (a column, an operator from a fixed list, a value), never text you write, and every
  value is a bound parameter.
- Rows go database → local server → your browser and nowhere else.
- Columns whose names look sensitive are not sent unless you reveal them. This is a convenience, not a
  control.
- The **SQL tab** is the only place where text you type becomes SQL (read-only, one statement). Since
  1.11.0 a Claude app, if you share a connection at the data level, can also send one read-only statement
  through the **same runner** (see [below](#what-claude-reads-1110)).
- **Statistics** (1.10.0) in the table details come from the server's own figures (null share, distinct
  count, width, order, sizes, last vacuum). **No row and no value is read** (the statistics that hold values
  are never selected), so they need no data-viewing switch.

## What Claude reads (1.11.0)

Only after you press **Share with Claude**, per connection, in memory only:

| Level                  | What a Claude app can ask for                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Structure**          | Connection names you gave, schema, table and column names, types, keys, indexes, foreign keys in both directions, the server's statistics. No row. (**Inference from the code:** also column defaults, comments and constraint text.) |
| **Structure and data** | Also pages of rows and one read-only statement at a time, with limits (see [Limits](/reference/limits/)). Needs **Allow viewing table data**; each call waits for your **Approve** by default.                                        |

- The answer travels DataCanvas → the Claude app on this machine → **Anthropic**, which DataCanvas cannot
  control. The dialog says so before anything is shared, and the data level needs a tick.
- **The host, user and password of a connection are never given to Claude**: it sees an id, the name you
  gave and the database name.
- Columns whose names look sensitive are left out of what Claude gets (a safety net, not a barrier: see "Letting Claude read a connection").
- A database's own error text is not passed on, because it can hold a value.
- The list of what Claude asked holds the request (a statement or a table) and counts, never a returned
  value. It lives in memory and is shown to you only.

See [Letting Claude read a connection](/security/risky-features/#letting-claude-read-a-connection-1110).

## Side doors considered

The threat model lists the ways rows could leave by accident (logs, errors, files, caches, secrets, screen
sharing, load, injection, row-level security) and the control for each:

| Side door          | Control                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs               | The server logs only error names and codes, never messages; tests assert no value reaches `console`.                                                                          |
| Error messages     | PostgreSQL's own message for a bad value contains the value, so class-22 errors become a fixed `invalid_request` sentence; write errors map from SQLSTATE to fixed sentences. |
| Files              | No row path touches storage; rule tests forbid `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `caches.` and `persist(` in `features/data`.                 |
| Screen sharing     | The **Blur values** switch hides values on screen only.                                                                                                                       |
| Load               | One page read at a time per connection, an export at a time, time limits, and `429` busy answers.                                                                             |
| Row-level security | Shown as a note only when it applies to your role.                                                                                                                            |

## Before you export or share a diagram

A PNG, SVG or workspace file shows **table and column names**, which can reveal how a system works. It
contains no row data, but share it only with people who should see your schema. A snapshot file can also
copy view queries and function bodies as written. The same goes for **Export documentation** (1.10.0:
Markdown, Mermaid, DBML, PlantUML): names and types, plus defaults, check rules and comments in the Markdown
and DBML files, which can hold a literal; no row. Check where you paste a text diagram.

---

**Sources:** [`SECURITY.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/SECURITY.md) (What stays on your machine, What DataCanvas reads),
[`docs/threat-model.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/threat-model.md) (assets, section 1b, sections 12 and 13),
[`apps/web/lib/server/mcp-service.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/mcp-service.ts) (what each tool returns),
[`packages/cli/src/mcp-file.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/mcp-file.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Phase 6 and data viewer M2/M3),
[`tests/security.test.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/tests/security.test.ts).
