# Getting started

## 1. Start DataCanvas

```bash
npx --yes @shubhamtiwari909/datacanvas
```

You need Node.js 20.9 or newer (`node --version`). The first run downloads the package (about 5 MB); later runs start from npm's cache in about a second. Add options after the command, for example `--port 4900 --no-open`. To skip `npx`, install it once with `npm install -g @shubhamtiwari909/datacanvas` and run `datacanvas`.

(Working on the code instead? In a clone of the repository, `npm install` then `npm run app` builds and runs it; pass options after `--`.)

It prints a private link such as `http://127.0.0.1:4747/?token=...`. The token is new on every run: it is what keeps other websites and programs out. Open the link (a browser opens by itself when possible). The token disappears from the address bar after the first load.

Press Ctrl+C in the terminal to stop. DataCanvas closes its database connections first.

## 2. Connect a database

Choose **Connect PostgreSQL**, then either paste a connection string

```text
postgresql://user:password@host:5432/database
```

or switch to the fields form. Press **Test connection** to check the details without keeping anything, or **Connect**.

Good practice:

- Use a **read-only user** with the least access that is useful. DataCanvas only reads metadata, but a read-only user makes that a guarantee.
- For a database that is not on your own computer, use **Encrypted and verified** (TLS with certificate checking).
- The password stays in memory. After a restart you are asked for it again; host, port, database and user can be remembered with **Save connection**.

## 3. Explore

- The **Overview** tab shows one card per schema: table and view counts, estimated rows, how it connects to other schemas, the most connected tables, the largest tables, and tables with no declared relationships. Click a table name to show it on the canvas, or **Add to canvas** for a whole schema (up to 1000 tables at once).
- The **Paths** tab answers "how are these two tables connected?": choose a start and an end table and DataCanvas shows the shortest chain of declared foreign keys (every equally short route, up to five), the columns joined at each step, and a `SELECT … JOIN …` to copy. Steps from a parent to its children are marked, because they can return one row many times. **Show on canvas** adds the tables on the route. If no chain of foreign keys connects the tables it says so; it never guesses from column names.
- The **Health** tab runs structural checks over every table (no table rows are read): missing primary keys, foreign keys without an index, foreign keys whose column types differ (integer against bigint), duplicate, redundant or unused indexes, nullable foreign keys, names that need quoting in a database of plain names, foreign key columns not named like the rest, and very wide tables. Unused indexes come from the server's own usage counters, not from table rows: the tab says since when they have been counting, and the list never includes indexes that enforce a primary key or unique constraint. A zero only means "not used since then, on this server", so check every server that answers queries before dropping anything. The two naming checks compare against the rest of your database (they only speak up when at least 80% of the names follow one style), never against a fixed rule. Each group explains why it matters; findings name the table (click to show it on the canvas) and, where a safe statement exists, give SQL to copy. Treat them as hints: only you know whether a finding matters for your database.
- The **Objects** tab shows what is in the database besides tables, one tab per kind with a name filter: **Views** (the query, what it reads and which views read it; click a name to show the table on the canvas), **Types** (enums with their values, domains, composite and range types), **Sequences** (settings and the column that owns each), **Functions** (definition, language, volatility, whether it runs with its owner's rights), **Triggers**, **Extensions** and **Policies** (row-level security per table, with a warning when security is on but no policy allows any row, or when policies exist but security is off). These are definitions and settings only: no table rows and no sequence values are read. Functions, types and views that belong to an installed extension are left out; the extension itself is listed.
- The **Snapshots** tab saves the structure of the database (no table rows and no connection credentials) so you can compare it later. **Take snapshot** reads the database and keeps the result under a name; **Compare** takes any two of: a saved snapshot, or the live database of any open connection (so two different databases can be compared too). The result counts what was added, removed and changed and lists each table with its column, constraint, index and foreign-key changes, and the changes to views, types, sequences, functions, triggers, extensions and policies (a changed view query or function body is shown before and after; a function is told apart by its name and arguments). A snapshot taken with an earlier release did not record those objects, so they are not compared against it (the screen says so; take a new snapshot); **Copy as Markdown** gives a report for a review or ticket. Things are matched by name, so a renamed table or column appears as one removed and one added. **Export** saves a snapshot as a `.snapshot.json` file and **Import file** loads one (as a new snapshot). The file lists table and column names and copies view queries and function bodies as written, so it can contain anything someone typed into them (a key, a password): treat it like the schema itself and look before you share it. A snapshot is read in several steps, so one taken while a migration is running can mix the before and after states; take it again when the database is quiet.
- The left list shows schemas and tables. Open a schema to see its tables; the dot marks tables already on the canvas.
- The grid button beside a schema ("Add all tables of this schema") puts it on the canvas. Use the search box to add one table or find a column.
- Click a table to see its details in the inspector: columns, relationships, constraints, indexes.
- **Layout** arranges tables (hierarchical, grouped by connected tables, compact, or a plain grid).
- **Explore** can focus on the selected table and the tables within 1 to 5 relationships of it, dimming or hiding the rest. **Filters** hides schemas, views or relationship types.

## 4. Keep and share

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
