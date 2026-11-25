# Getting started

## 1. Start DataCanvas

```bash
npx --yes @shubhamtiwari909/datacanvas
```

You need Node.js 20.9 or newer (`node --version`). The first run downloads the package (about 5 MB); later runs start from npm's cache in about a second. Add options after the command, for example `--port 4900 --no-open`. To skip `npx`, install it once with `npm install -g @shubhamtiwari909/datacanvas` and run `datacanvas`.

(Working on the code instead? In a clone of the repository, `pnpm install` then `pnpm run app` builds and runs it; pass options after `--`.)

It prints a private link such as `http://127.0.0.1:4747/?token=...`. The token is new on every run: it is what keeps other websites and programs out. Open the link (a browser opens by itself when possible). The token disappears from the address bar after the first load.

Press Ctrl+C in the terminal to stop. DataCanvas closes its database connections first.

## 2. Connect a database

Choose **Connect PostgreSQL**, then either paste a connection string

```text
postgresql://user:password@host:5432/database
```

or switch to the fields form. Press **Test connection** to check the details without keeping anything, or **Connect**.

Good practice:

- Use a **read-only user** with the least access that is useful. Unless you start it with `--enable-writes` (section 5), DataCanvas only reads (metadata, and rows if you switch that on), and a read-only user makes that a guarantee. DataCanvas warns beside the connection when the user can change data or create objects.
- For a database that is not on your own computer, use **Encrypted and verified** (TLS with certificate checking).
- The password stays in memory. After a restart you are asked for it again; host, port, database and user can be remembered with **Save connection**.

## 3. Explore

- **Export documentation** (a button on the **Overview** tab, and in the canvas export dialog) writes the structure of the whole database, or of one schema, as a **Markdown data dictionary**, or as a **Mermaid**, **DBML** or **PlantUML** diagram for GitHub, dbdiagram.io or PlantUML. It is made in your browser from names and types only: no row, no value, no need for data viewing, nothing uploaded.
- The **Overview** tab shows one card per schema: table and view counts, estimated rows, how it connects to other schemas, the most connected tables, the largest tables, and tables with no declared relationships. Click a table name to show it on the canvas, or **Add to canvas** for a whole schema (up to 1000 tables at once).
- The **Paths** tab answers "how are these two tables connected?": choose a start and an end table and DataCanvas shows the shortest chain of declared foreign keys (every equally short route, up to five), the columns joined at each step, and a `SELECT … JOIN …` to copy. Steps from a parent to its children are marked, because they can return one row many times. **Show on canvas** adds the tables on the route. If no chain of foreign keys connects the tables it says so; it never guesses from column names.
- The **Health** tab runs structural checks over every table (this tab reads no table rows): missing primary keys, foreign keys without an index, foreign keys whose column types differ (integer against bigint), duplicate, redundant or unused indexes, nullable foreign keys, names that need quoting in a database of plain names, foreign key columns not named like the rest, and very wide tables. Unused indexes come from the server's own usage counters, not from table rows: the tab says since when they have been counting, and the list never includes indexes that enforce a primary key or unique constraint. A zero only means "not used since then, on this server", so check every server that answers queries before dropping anything. The two naming checks compare against the rest of your database (they only speak up when at least 80% of the names follow one style), never against a fixed rule. Each group explains why it matters; findings name the table (click to show it on the canvas) and, where a safe statement exists, give SQL to copy. Treat them as hints: only you know whether a finding matters for your database.
- The **Objects** tab shows what is in the database besides tables, one tab per kind with a name filter: **Views** (the query, what it reads and which views read it; click a name to show the table on the canvas), **Types** (enums with their values, domains, composite and range types), **Sequences** (settings and the column that owns each), **Functions** (definition, language, volatility, whether it runs with its owner's rights), **Triggers**, **Extensions** and **Policies** (row-level security per table, with a warning when security is on but no policy allows any row, or when policies exist but security is off). These are definitions and settings only: this tab reads no table rows and no sequence values. Functions, types and views that belong to an installed extension are left out; the extension itself is listed.
- The **Snapshots** tab saves the structure of the database (a snapshot never contains rows, whether or not data viewing is on, and no connection credentials) so you can compare it later. **Take snapshot** reads the database and keeps the result under a name; **Compare** takes any two of: a saved snapshot, or the live database of any open connection (so two different databases can be compared too). The result counts what was added, removed and changed and lists each table with its column, constraint, index and foreign-key changes, and the changes to views, types, sequences, functions, triggers, extensions and policies (a changed view query or function body is shown before and after; a function is told apart by its name and arguments). A snapshot taken with an earlier release did not record those objects, so they are not compared against it (the screen says so; take a new snapshot); **Copy as Markdown** gives a report for a review or ticket. Things are matched by name, so a renamed table or column appears as one removed and one added. **Export** saves a snapshot as a `.snapshot.json` file and **Import file** loads one (as a new snapshot). The file lists table and column names and copies view queries and function bodies as written, so it can contain anything someone typed into them (a key, a password): treat it like the schema itself and look before you share it. A snapshot is read in several steps, so one taken while a migration is running can mix the before and after states; take it again when the database is quiet.
- The details of a table also show its **Statistics** from the server's own figures: for each column the share of NULLs, the number of distinct values, the average width and whether the values follow the order of the rows; for the table its rows (an estimate), its size, its indexes' size, the dead rows and when it was last vacuumed and analysed. They read no row, so they are there with data viewing off. A table that was never analysed has no column figures, and says the planner is guessing.
- The left list shows schemas and tables. Open a schema to see its tables; the dot marks tables already on the canvas.
- **Find a table** at the top of the left list narrows it to the tables and views whose name contains what you type, in every schema, including the ones you have not opened (the first search loads each schema's table list once). Click a result as you would in the tree; **Escape** or the clear button brings the tree back as it was. What you type stays in your browser.
- The grid button beside a schema ("Add all tables of this schema") puts it on the canvas. Use the search box to add one table or find a column.
- Click a table to see its details in the inspector: columns, relationships, constraints, indexes, and, if you have allowed it, its rows (next section).
- **Layout** arranges tables (hierarchical, grouped by connected tables, compact, or a plain grid).
- **Explore** can focus on the selected table and the tables within 1 to 5 relationships of it, dimming or hiding the rest. **Filters** hides schemas, views or relationship types.

## 4. Look at the rows (optional)

By default DataCanvas reads only the structure of your database. To see the rows of a table, switch on **Allow viewing table data** for that connection: tick it in the connect dialog, or use the switch beside the connection in the left list, or the button in a table's **Data** section. It is off for every new connection, a badge shows when it is on, and a saved connection remembers your choice (you still enter the password again after a restart).

What you get, for the table you have open:

- **One page of rows at a time**, read-only: 50 rows by default (25, 50, 100 or 200), **Previous** and **Next**, and an estimate of the table's size (never a count, which would scan the table). Rows are in primary-key order, or in the order of a unique index when there is no primary key. A table with no usable key has no guaranteed order and can be paged only through its first 10,000 rows (it says so), and so can a materialized view.
- **Values as text.** NULL (italic) is never confused with the empty string ("(empty)"). A value longer than 200 characters is cut in the grid; click it, or press **Enter** on it, to read up to its first 2,000 characters with a **Copy** button. Wider tables show the first 100 columns, and say so.
- **Keyboard use.** One cell is a tab stop; the arrow keys, **Home**, **End**, **Page Up** and **Page Down** move between cells.
- **Hidden columns.** A column whose name looks sensitive (`password`, `token`, `secret`, `api_key` and similar) is **not read at all** until you press its **Show** button, so its values never reach your browser by default. This is a convenience, not a security control: a name is only a hint (a column called `notes` can hold a password, and `token_count` is harmless). If a user must not see something, give DataCanvas a database user that cannot read it. **Hide** reads the page again without that column, and the choice lasts only for the view you have open.
- **Blur values.** A switch above the grid blurs every value in the grid and in the value dialog, for sharing your screen. It changes how values look and nothing else.
- **Row-level security.** If it is on for the table and applies to your database user, a note says you may not see every row. The database decides which rows you may read; DataCanvas cannot show the others.
- **Sorting.** Click a column header to sort by it: ascending, then descending, then back to the key order. NULL comes last when ascending and first when descending (the database's own order), and rows that tie are ordered by the table's key, so every row appears exactly once as you page. A column that cannot be sorted has no button and a tooltip that says why: it is hidden (show it first), the table has no primary key or unique index to break ties, or its type has no useful order (`json`, `jsonb`, arrays and similar). Changing the sort starts again from the first page.
- **Filtering.** The **Filter** button opens a small panel: choose a column, a condition and a value, and **Add filter**. Up to three conditions can be in force, all of which must match; each shows as a chip you can remove, and **Clear all** removes them. Text columns offer **equals**, **does not equal**, the comparisons, **contains** and **starts with**; numbers, dates, booleans and enums offer equals, does not equal and the comparisons; every column offers **is NULL** and **is not NULL**, and columns of other types (`json`, arrays) offer only those two. **contains** and **starts with** ignore case and take what you type literally: `%` and `_` are ordinary characters, there are no patterns. **does not equal** also matches rows where the value is NULL. The value has to fit the column (a number for a number, a date such as `2026-01-31` for a date); if it does not, the page says so and the filter can be removed. A hidden column can be filtered once you have shown it, and hiding it again removes its filters and any sort on it. Filtering works on tables without a key too. While a filter is on the page says "filtered" instead of the size estimate, because a count would scan the table.
- **Time limit.** A read with a sort or a filter is stopped after 5 seconds (a plain page keeps the usual limit), and the page says so. On a very large table, sort or filter by a column that has an index; **contains** on wide text is the slowest condition.

Limits and rules: only tables, partitioned tables, views and materialized views (a foreign table lives on another server and is not read), at most 2 MB per page (a shortened page says so), and a time limit on every read. Rows are held in memory while the Data section is open and are gone when you open another table, switch data viewing off, or disconnect; they are never saved to a file, logged, or put in a snapshot or a workspace. The sort, the filters and the values you typed in them are held the same way: they last for the view you have open, another table starts with neither, and nothing about them is stored.

### Export, the JSON editor and Validate

- **Export.** The **Export** button in the Data section writes the rows you are looking at, with the filter and sort on screen, to a file on your computer: **CSV** (with a byte order mark, so a spreadsheet opens it as UTF-8; comma or semicolon), **TSV**, **JSON** (an object with `rows` and `_meta`) or **NDJSON** (one object per line). Up to 100,000 rows and 64 MB: a longer table ends the file with a line that says it was cut, and **Cancel** stops the read. Columns whose names look sensitive are left out unless you showed them, and the notes at the end of the file name them. NULL is an empty field in CSV and TSV unless you give it a word. A value a spreadsheet would run as a formula starts with an apostrophe.
- **JSON editor.** A `json` or `jsonb` cell has **Open as JSON** in its dialog, and the edit and add-row forms have **Edit as JSON** beside the field. It colours the text, shows the line and column where it stops being JSON, **Format** and **Minify** keep every number and string exactly as written, a **Tree** shows a large document with the path of any part (copyable), and **Changes** compares with the loaded value. A value the grid cut short is read whole (up to 1 million characters). A document over 100,000 characters can be read but not edited here.
- **Export the rows you chose, and a script of INSERT statements.** Every grid with a key has a checkbox on each row (Shift for a range, a box for the page); with rows chosen, **Export chosen** writes just those rows (up to 500), read again on the server by their keys. The **SQL INSERT statements** format writes `BEGIN; ... COMMIT;` with every value quoted, 100 rows to a statement, generated columns left out and identity columns kept; a script that was cut ends with `ROLLBACK;`, so only a whole script changes anything when you run it. Run it in an empty copy of the table.
- **Validate.** In the edit and add-row forms, **Validate** asks the database whether it would accept the values and writes no row. (An event trigger in the database can still run during the check, and the report says so.) It names the rule (NOT NULL, a CHECK, a value that does not fit the type, a unique key already taken, a missing parent), and what it did not check (triggers, row-level security).

## 5. Change rows and tables (optional)

DataCanvas does not change your database unless you ask for it three times:

1. **Start it with `--enable-writes`**, for example `npx --yes @shubhamtiwari909/datacanvas --enable-writes`. It prints a notice that writes are enabled. Without the flag, nothing in the app can change a database.
2. **Use a database on this machine.** Writes are offered only when the host is `localhost`, `127.0.0.1` (any `127.x` address) or `::1`. Any other connection stays read-only.
3. **Unlock writes for the connection**: use the **Writes** switch beside it in the left list and type the database name. Viewing table data must be on. The dialog shows the address the database server reports and any warning about your database user. While writes are unlocked a red **Writes on** badge is shown; **Lock writes** ends it, and so do disconnecting, reconnecting and stopping DataCanvas. The unlock is never saved.

A tunnel (`ssh -L`) or a proxy such as the Cloud SQL Auth Proxy also listens on `127.0.0.1` but forwards to another server, possibly a production one, so it looks local. Check the address in the unlock dialog, and only unlock a database you are willing to change. **Changes are committed immediately and cannot be undone.**

What you can do with writes unlocked:

- **Edit a row** in a table's **Data** section: choose a cell or the row's **Edit** button, type the new values (NULL and an empty value are separate choices), and **Preview**. **Add row** opens a form with every column: give a value, NULL, or leave it to its default; columns the database fills (generated columns and `GENERATED ALWAYS` identities) cannot be set. **Delete** removes one row. A table needs a primary key, or a unique index that is not partial, covers plain columns (no expressions) and has only columns that cannot be NULL, to be edited; views, materialized views and foreign tables cannot be. Long values cut in the grid, hidden columns and `bytea` columns cannot be edited, and the grid says why.
- **Create a table** with **New table** beside a schema: columns with a type from a fixed list (numbers, text, dates and times, `uuid`, `json`, `jsonb`, `bytea`, `inet`, and arrays of these), whether each can be NULL, a default from a fixed list (a value, the current time or date, a random UUID, true or false) or an identity, a primary key, unique columns, foreign keys to existing tables, and comments.
- **Change a table** with **Edit structure** in its details: add, rename and drop columns, rename and drop the table, change a column's type (only where PostgreSQL can convert it on its own), set or drop NOT NULL and a default, add a primary key, unique constraint or foreign key, drop a constraint, and create or drop an index. A drop needs the table name typed, and is refused, with the list of what depends on it, while a view, a foreign key or an index uses it.

- **Change several rows together.** With writes unlocked, the Data section has a checkbox on each row of a table that can be edited (a click with Shift chooses a range, the header's box chooses the page, and the choice is kept while you change page or filter). With rows chosen, **Set a value** puts one value in one column of all of them and **Delete rows** removes them, up to 500 at a time, always through a preview. A row that changed since you loaded it is left out and counted before anything is written (for **Delete**, only a row that is gone: a delete is found by its key and compares no values), and if one changes while you are looking at the preview, nothing is written and the page says so.
- **Import a CSV file.** **Import CSV** in the Data section reads a file from your computer (UTF-8, comma, semicolon, tab or pipe, with or without a header, up to 100,000 rows and 20 MB; it is read in your browser and is not uploaded as a file). Choose a column of the table for each column of the file or leave it out, say whether an empty field is NULL or an empty string and which words (for example `NULL`) also mean NULL, and **Validate the file**: the database checks every row against the table's rules without writing, and names the rows of the file that fail. **Preview the import** shows the statement and how many batches it takes, and **Apply** adds every row in one transaction: if any row fails, none is added, and **Cancel and roll back** stops it. Columns the table needs that the file does not give are named before you can preview. To skip bad rows, fix the file and try again.

Every change opens a **preview** first: the exact statement that will run (values appear as `$1`, `$2`, ...; you can copy it), the values before and after, and what to know before applying: triggers that will run, foreign keys from other tables and what they do, row-level security, and whether a change locks or rewrites the table. Deleting and dropping need a tick to confirm. **Apply** runs exactly the statement you saw, in one transaction; a preview can be applied once and expires after five minutes. If a column you are changing no longer holds the value you saw (someone else changed it), nothing is written and the page says so; other columns are not compared, and a delete does not compare values. Errors from the database are shown as a fixed sentence (for example "A row with the same value already exists"), never with your values in them.

**Changes** (from the badge) lists what you changed in this session: the kind of change, the table, the column names, the time and the outcome, and the statement for changes of structure (left out when it holds a default value or a comment you typed). It never shows row values and is not saved.

## 6. Run SQL (optional, read-only)

Open the **SQL** tab. It needs **Allow viewing table data** for the connection (a result is rows); until then it says so and offers to switch it on. It never changes your database, even with `--enable-writes`.

- **Type a statement and press Run** (or Ctrl or Cmd plus Enter). If some text is selected, only the selection runs. **Cancel** stops it in the database. Only `SELECT`, `WITH`, `VALUES`, `TABLE`, `EXPLAIN` and `SHOW` are accepted, one statement at a time.
- **Completion** suggests the tables, views and schemas of your database after `FROM` and `JOIN`; elsewhere the columns of the tables in your statement (with their types), then aliases, functions and keywords; and a table's or alias's columns after `alias.`. Press Ctrl or Cmd plus Space to open it. Keywords and built-in functions are offered too.
- **Query tabs** keep several statements, each with its own result: **+** opens one, double-click or the pencil renames it, the copy button duplicates it, **x** or Delete closes it. Only one statement runs at a time, whichever tab it is in. Queries are **not kept** when you close the page: save a tab with the download button (a `.sql` file) and open one with the folder button.
- **The result** is a table: NULL and an empty value look different, a long value opens in a dialog, and the footer says how many rows, how long it took, and when rows were left unread (the **Row limit** is 100, 1,000, 5,000 or 10,000). **Export** copies the rows as TSV, CSV or JSON, or saves a CSV file. A value that a spreadsheet would run as a formula is saved with a leading apostrophe.
- **Explain** shows the plan of the statement; **Explain analyze** runs the statement and shows the plan with the real times. Both work on a query only.
- **History** (the clock button) lists what ran on this connection since you opened the page, with how each went; open one in a new tab, run it again, copy it or clear the list.
- **Errors** show the database's own sentence and the line and column, and the place is marked in the text.
- If the role you connected with is a superuser, or may run programs or read files on the database server, a note says so: a function can reach those through a `SELECT`. Use a read-only role for SQL you did not write.

## 7. Write a migration (optional, nothing is run)

Open the **Migrations** tab, or take a comparison in **Snapshots** and press **Generate a migration from this comparison**. Choose **From** and **To** (a snapshot, or the live database of any connection) and press **Generate migration**: the result makes _From_ look like _To_. **Swap** reverses it.

- **The summary** says how many steps there are, what they risk (take a lock, rewrite a table, can fail on existing rows, destroy data) and how much of it a rollback can undo.
- **Steps** are in the order they run. Each has badges, one sentence, and its SQL (up and down) one click away. Untick a step to leave it out: the steps that need it go with it, and the screen says so. Changing an option starts the choices again.
- **Destructive steps** (a dropped table, column, view, function) are written **commented out** until you confirm that step.
- **Possible renames** are offered with the reason (a table that is gone and one that is new with the same columns, a column of the same type in the same place). A comparison cannot tell a rename from a drop and an add: **a rename keeps the rows, a drop and an add does not**, so nothing is renamed until you tick it.
- **Options**: create indexes without blocking writes (such a step cannot run in a transaction), and add checks and foreign keys unvalidated, then validate.
- **The text** has the script, the rollback, and the notes: what needs a person and what was not compared (owners and grants, partitioning and storage options, views' options, the position of a sequence, row data).
- **Export** writes plain SQL (for `psql -v ON_ERROR_STOP=1 -f`), one file for **dbmate** or **goose**, a **Flyway** pair, or `up.sql` and `down.sql`. A step that cannot be in a transaction is written outside it, in its place. Each file begins with what it compares and a reminder to read it: it contains view and function definitions read from the databases. A format is refused when a name in the migration would be read by that runner as one of its own commands.

Read the script before you run it anywhere. DataCanvas writes the text and never runs it. Some things cannot be undone (a dropped table's rows, a new enum label), and the rollback says which.

To find out whether a migration will work on your data, choose a **live database as From** and press **Check against the data**: each step that can fail says how many rows would make it fail (NULLs before `SET NOT NULL`, shared values before a unique key, rows with no parent before a foreign key, rows at all before a required column with no default). A check constraint and a type conversion are not tried: it says so, and you can try them in the SQL tab. It needs **Allow viewing table data** and reads only counts.

## 8. Use DataCanvas from Claude (optional, read-only)

**Share with Claude**, under a connection in the sidebar, lets a Claude app (Claude Desktop, Claude Code, any MCP client) read that database through DataCanvas: explain the schema, find tables, and answer questions with read-only queries. DataCanvas holds no API key and calls no cloud service: your Claude app asks, DataCanvas answers on your machine.

1. Connect the database, then press **Share with Claude** and choose a level:
   - **Structure**: schemas, tables, columns, types, keys, indexes, foreign keys and the server's statistics. No row of any table.
   - **Structure and data** (needs **Allow viewing table data** for the connection): also pages of rows and read-only queries. Tick that you understand that rows Claude reads are sent to Anthropic by the Claude app. If your database user is a superuser, or can read server files or run programs, you are asked once more (**Share anyway**): use a read-only user instead.
2. Connect the Claude app **once**. The dialog shows the text and a Copy button: for **Claude Code** run `claude mcp add datacanvas -- npx --yes @shubhamtiwari909/datacanvas mcp`; for **Claude Desktop** add the shown entry to `claude_desktop_config.json` and restart it. The text holds no secret and is the same on every run. The `mcp` command finds the running DataCanvas by itself, and says "start DataCanvas" in plain words when there is none. If Claude Desktop says "Connection closed", it cannot find `npx` (it does not read your shell's `PATH`, which matters with nvm, Volta or Homebrew): use the full path of `npx` as the command and add its folder to `env.PATH` (see `docs/agent-setup.md`).
3. Ask Claude about the database. At the data level each call opens a prompt that shows what Claude asked (a statement, or a table). Nothing runs until you press **Approve**; **Deny** refuses it; Escape does not answer; after two minutes it is refused. You can turn the prompt off in the dialog if you accept calls without looking.
4. **Pause** (next to the sharing in the sidebar) refuses every call at once; **Resume** lets the next through. **Stop sharing** ends it. The dialog lists **what Claude asked** and how each call ended, with counts, never a value that came back.

What to know: sharing is kept in memory only and ends when you stop it, disconnect, switch off viewing table data or close DataCanvas. There is no tool that changes anything. Columns whose names look sensitive are left out of what Claude gets, but that is a safety net against accidents, not a barrier (a model that is told to can get around it); use a database user that cannot read what must not leave. A Claude app that can run commands on your computer (Claude Code) can also approve its own calls. At most 30 calls a minute are served. **Anything Claude reads is sent to Anthropic by the Claude app, and DataCanvas cannot take it back.**

## 9. Keep and share

- Layouts are saved automatically for saved connections and restored when you reconnect.
- **Export** saves a PNG or SVG. These images show table and column names, so share them only with people who should see your schema.

## Dark mode

The sun or moon button in the top bar chooses **Light**, **Dark** or **System** (follow your operating system, live). The choice is saved in your browser only.

## Cloud databases

DataCanvas connects over the network (TCP) to a host name or IP address. Paste the provider's connection string, or fill in the fields. Accepted shapes:

```text
postgresql://user:password@host:5432/database
postgresql://user:password@/database?host=host.example.com&port=5432   (host in the query, as libpq writes it)
```

Add `?sslmode=require` or `?sslmode=verify-full` to choose the encryption (a remote host defaults to the strictest, `verify-full`). Other parameters in the string (such as Prisma's `schema=`) are ignored on purpose.

**Google Cloud SQL.** A string with `?host=/cloudsql/PROJECT:REGION:INSTANCE` is the form used _inside_ Google Cloud (Cloud Run, App Engine) and cannot work from your computer: `/cloudsql/...` is a Unix socket that only exists there. DataCanvas says so. Two ways in from your computer:

1. **Cloud SQL Auth Proxy** (recommended). Run it with the instance name (the part after `/cloudsql/`) and a local port, following Google's current instructions, then connect DataCanvas to `postgresql://user:password@127.0.0.1:<that port>/database`. A local address defaults to no extra SSL, which is right because the proxy encrypts.
2. **Public IP.** Enable a public IP on the instance, authorise your current IP in its networks, and use `postgresql://user:password@PUBLIC_IP:5432/database?sslmode=require`.

**Certificates.** `verify-full` checks the server's certificate against the authorities your Node.js trusts. Providers that sign with their own authority (Amazon RDS, Google Cloud SQL, Supabase direct connections) will fail that check, and DataCanvas cannot yet be given a CA file. `sslmode=require` still encrypts but does not verify who answers, so it is weaker on an untrusted network.

**Other things to know.** A database that is reachable only inside a private network needs a VPN or a tunnel first (DataCanvas has no built-in tunnel). Serverless databases that sleep can take longer than the 10 second connect timeout on the first try; try again. Short-lived IAM tokens work only if you paste a fresh one as the password. Poolers such as PgBouncer are supported by design (each operation is one short read-only transaction), but none of these services has been tested against a real account. Use a read-only user.

## When something goes wrong

| You see                                    | Try                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| "needs Node.js 20.9 or newer"              | Install a current LTS version from nodejs.org.                                               |
| "Port ... is already in use"               | Omit `--port` (a free one is chosen) or pick another.                                        |
| "Open DataCanvas with the link printed..." | You opened the address without the token. Use the link the command printed.                  |
| Authentication failed                      | Check the user name and password.                                                            |
| "The host is a Unix socket path"           | The string points at a socket (`/cloudsql/...`). See Cloud databases above.                  |
| Could not reach the database               | Check host and port, and that the server accepts connections from your computer.             |
| Encryption (SSL) error                     | The server may not offer TLS. Choose the matching encryption option.                         |
| Connecting from a container                | `localhost` inside a container is the container. Use the host's address or the service name. |

Your files are in `~/.datacanvas`. Set `DATACANVAS_HOME` to use another folder.
