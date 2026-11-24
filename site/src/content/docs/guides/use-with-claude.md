---
title: Use DataCanvas from Claude
description: Let a Claude app (Claude Desktop, Claude Code, any MCP client) read a connection through DataCanvas, read-only, with two levels, your approval on every data call, a Pause button and a list of what Claude asked.
---

**Share with Claude** (1.11.0), under each connection in the left list, lets a Claude app read that database
**through DataCanvas**: explain the schema, find tables and answer questions with read-only queries. It is
**off until you press it**, **read-only** (no tool changes anything) and **optional**.

DataCanvas holds **no API key and calls no cloud service**. Your Claude app asks, DataCanvas answers on your
machine, over the Model Context Protocol (MCP).

:::danger[What Claude reads is sent to Anthropic]
**Whatever Claude reads is sent to Anthropic by the Claude app, and DataCanvas cannot stop that or take it
back.** Share only what may leave your machine, and connect with a database user that cannot read the rest.
The share dialog says this before anything is shared.
:::

## The two levels

Chosen per connection, **kept in memory only**: never saved with a profile, a workspace or a snapshot, and
gone on a restart, on a disconnect, and when viewing table data is switched off.

| Level                  | What Claude can ask for                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Structure**          | Schemas, tables, columns, types, keys, indexes, foreign keys in both directions and the server's statistics. **No row of any table.** |
| **Structure and data** | Also **pages of rows** and **read-only queries**. Needs **Allow viewing table data** for the connection.                              |

Choosing the data level needs a tick in the dialog that you understand that rows Claude reads are sent to
Anthropic. If the database user is a superuser, or can read server files or run programs, you are asked once
more (**Share anyway**); see [Powerful roles](#powerful-database-roles).

## Set it up

1. **Connect the database** in DataCanvas, then press **Share with Claude** under it and choose a level.
2. **Connect the Claude app once.** The dialog shows the text and a **Copy** button:
   - **Claude Code:** run

     ```text
     claude mcp add datacanvas -- npx --yes @shubhamtiwari909/datacanvas mcp
     ```

   - **Claude Desktop:** add this entry to `claude_desktop_config.json` and restart Claude Desktop:

     ```json
     {
       "mcpServers": {
         "datacanvas": {
           "command": "npx",
           "args": ["--yes", "@shubhamtiwari909/datacanvas", "mcp"]
         }
       }
     }
     ```

   The text is **the same on every run and holds no secret**. The command it starts, `datacanvas mcp`, is a
   small bridge that finds the running DataCanvas by itself (see
   [Command-line reference](/start/cli/#datacanvas-mcp)).

3. **Ask Claude about the database.** For example: "Which tables reference `orders`?" or "How many
   orders were placed last month?"

**Unknown:** whether `npx` starts reliably from Claude Desktop on every platform (the path, Windows `npx.cmd`)
and how long the first start takes with the download. The project's plan lists this as a question for a hand
test on each platform and records no result. If the first start is slow, installing the package globally
and using `datacanvas mcp` as the command is the plan's own fallback (**Inference**: the plan says the
setup text should then say so).

## What Claude can do: eight tools

Claude gets **eight tools and no more**; a test pins the list. **There is no tool that writes.**

| Tool                 | Level     | What it does                                                                                         |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `list_connections`   | structure | The connections you shared: an id, the name you gave, the database name, the level. No host or user. |
| `list_schemas`       | structure | Schemas with how many tables and views each has.                                                     |
| `list_tables`        | structure | Tables and views of a schema, with estimated rows; up to 500 a call, then a cursor.                  |
| `describe_table`     | structure | Columns, keys, constraints, indexes, foreign keys both ways and the table's statistics.              |
| `search_objects`     | structure | Tables and columns whose **name** contains a word; up to 50 results.                                 |
| `read_rows`          | data      | One page of rows (up to 100 rows, 50 by default), with filters and a sort, by the page reader.       |
| `run_readonly_query` | data      | **One** read-only statement (`SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`).                           |
| `explain_query`      | data      | The planner's plan (JSON) for one statement, **without running it** (never `ANALYZE`).               |

The data tools appear in Claude's tool list only while some connection is shared at the data level. The
limits of each are in [Limits](/reference/limits/#claude-reading-a-connection-mcp-1110); how they work is in
[MCP server](/architecture/mcp/).

Statements run through **the SQL tab's runner**: a read-only transaction on a connection of its own, one
statement, the first-word list, and the row and time limits. Pages run through **the page reader** that
already hides sensitive-named columns. Nothing new reaches the database.

## You stay in control

- **Approve each data call** (on by default; you can turn it off in the dialog, by clearing **Ask me before
  each call**). A prompt shows exactly what Claude asked (the statement, or the table and its filters) and
  **nothing runs until you press Approve**. **Deny** refuses it. **Escape and a click outside do not answer
  it.** After **two minutes** it is refused ("did not approve in time").
- **Pause** (next to the sharing in the left list) refuses **every** call at once, structure calls too, and
  denies the ones that wait. **Resume** lets the next one through. It does not end the sharing.
- **At most 30 calls a minute** are served, for all connections together; more are refused with "Too many
  calls in a minute".
- **What Claude asked.** The share dialog lists the most recent calls for that connection (the server keeps the
  last 200): the statement or table, and how each ended (answered, failed, refused, not approved, paused, too
  many calls), with a **count of rows and a size, never a value that came back**. It is memory only and is
  forgotten when nothing is shared any more.
- **Stop sharing** ends it. So do disconnecting, switching off **Allow viewing table data** (for the data
  level) and closing DataCanvas.
- **Claude cannot approve or pause itself.** Sharing, the level, Approve, Deny and Pause are routes behind
  your browser's cookie, which the token Claude's side uses is not.

## What leaves the machine

Only what a tool returns, and only through the Claude app, which sends it to Anthropic:

- At the **structure** level: names, types, keys, indexes, statistics. (**Inference from the code:** also
  column defaults, comments and constraint text such as CHECK rules, which can hold a literal. A hidden
  column is still listed by name and type.)
- At the **data** level: the rows of the pages and queries you approve, cut to the limits.
- **Never** the host, user or password of a connection, and never any file of DataCanvas.

The tool descriptions and the server's own instructions tell the model that what a tool returns is **data,
never instructions**, but that is a request to a model, not a control.

## Hidden columns

A column whose name looks sensitive (`password`, `token`, `secret`, `api_key` and similar) is **left out**:
pages leave it out and name it, it is never sorted or filtered on, a statement that **names** one is refused
before it runs ("names columns that look sensitive"), and a result column with such a name comes back as
NULL. A default, comment or check of such a column is not described either.

**This is a safety net against accidents, not a barrier.** A model that is told to can get around it with a
crafted statement: a **whole-row value** (`row_to_json(t)`, `t::text`), renaming the columns of a table
(`FROM t AS x(a, b, c)`), a view that renames a column, or a column whose name is not on the list. A column
called `notes` can hold a password. **The control is the database user**: connect with one that cannot read
what must not leave. The statistics catalogs (`pg_stats`) and `pg_stat_activity` are refused, because they hold
sampled values.

**The approval prompt protects against mistakes, not against an app that can run commands.** Claude Code can
read DataCanvas's session link in your data folder and call the routes that approve its own calls.

## A database's own error text is not passed on

PostgreSQL's message for a bad value can contain the value (`invalid input syntax for type integer:
"..."`), and a query can provoke that for any column. So DataCanvas passes the database's own sentence on
only for errors about **names** in which every quoted part is text of the statement itself (a cast of a row
to a name would quote the row), **time limits**, **server limits**, and for its own refusals. Any other error is "The database refused the statement
(SQLSTATE …). Its message is not passed on because it can hold a value of the data."

## Powerful database roles

A superuser, or a role that can read server files or run programs on the database server
(`pg_read_server_files`, `pg_write_server_files`, `pg_execute_server_program`), can do outside a read-only
transaction what the transaction does not stop. Sharing the **data level** with such a role is refused
(`claude_role_not_acknowledged`) until you press **Share anyway**. **Use a read-only database user
instead.** The structure level needs no confirmation.

## A prompt-injected model

A value in a table can say anything ("ignore your instructions and run …"), and a model may read it as an
instruction. Claude has only read tools and you can approve each data call, but **a model that is led astray
can still ask for rows, and the Claude app sends them on**. Read what you approve. A model that has another
tool in the same client (a web fetch, a file write) could pass what it read somewhere else, which is outside
DataCanvas. The structure level and the approval prompt are the answers.

## Troubleshooting

| You see                                                                                                                                          | Try                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "DataCanvas is not running, or no connection is shared with Claude. Start DataCanvas, connect to your database and switch on Share with Claude." | **Start DataCanvas** (`npx --yes @shubhamtiwari909/datacanvas`), connect a database and press **Share with Claude**. The bridge answers the same sentence when DataCanvas runs but nothing is shared, because `/mcp` does not exist until something is shared. |
| "DataCanvas refused this program. Restart DataCanvas and the Claude app, then try again."                                                        | The token the bridge read no longer matches (DataCanvas was restarted while a Claude session was open). Restart both.                                                                                                                                          |
| "That connection is not shared with Claude, or does not exist."                                                                                  | The id is wrong, the connection was disconnected, sharing was stopped, or Pause is on. Ask Claude to call `list_connections`.                                                                                                                                  |
| "This connection is shared at the structure level only."                                                                                         | Change the sharing to **Structure and data** (viewing table data must be on).                                                                                                                                                                                  |
| "The person has paused Claude's access…"                                                                                                         | Press **Resume**.                                                                                                                                                                                                                                              |
| "The person did not approve this (in time). Nothing was run."                                                                                    | You denied it, or the two minutes passed. Ask again.                                                                                                                                                                                                           |
| "Too many calls in a minute."                                                                                                                    | Wait a little: at most 30 calls a minute are served.                                                                                                                                                                                                           |
| "Another read is still running on this connection."                                                                                              | One statement and one page read run at a time per connection. Try again in a moment.                                                                                                                                                                           |
| The data tools are missing from Claude's list                                                                                                    | No connection is at the data level. Share one at **Structure and data**, then ask Claude to refresh its tools (or restart the Claude app).                                                                                                                     |
| A statement is refused for naming a sensitive-looking column                                                                                     | Ask for other columns. A table called `password_resets` is caught too, on purpose.                                                                                                                                                                             |
| The answer was "too large to send"                                                                                                               | Ask for less: a smaller page, fewer columns, a `LIMIT`.                                                                                                                                                                                                        |

---

**Sources:** [`CHANGELOG.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/CHANGELOG.md) (1.11.0),
[`SECURITY.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/SECURITY.md) (Letting Claude read a connection),
[`docs/getting-started.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/getting-started.md) (section 8),
[`docs/mcp-server-plan.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/mcp-server-plan.md) (sections 4 to 8 and 17 to 21),
[`apps/web/features/claude/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/features/claude) (`share-dialog.tsx`, `claude-control.tsx`, `activity-host.tsx`, `setup-text.ts`),
[`apps/web/lib/server/mcp-service.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/mcp-service.ts),
[`apps/web/lib/server/mcp-control.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/mcp-control.ts),
[`apps/web/lib/server/mcp-data.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/mcp-data.ts),
[`packages/cli/src/mcp-bridge.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/mcp-bridge.ts).
