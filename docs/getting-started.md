# Getting started

## 1. Start DataCanvas

```bash
npx --yes datacanvas
```

You need Node.js 20.9 or newer (`node --version`). The first run downloads the package (about 5 MB) and starts in under a second afterwards.

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
- The **Health** tab runs structural checks over every table (no table rows are read): missing primary keys, foreign keys without an index, duplicate or redundant indexes, nullable foreign keys, very wide tables. Each group explains why it matters; findings name the table (click to show it on the canvas) and, where a safe statement exists, give SQL to copy. Treat them as hints: only you know whether a finding matters for your database.
- The left list shows schemas and tables. Open a schema to see its tables; the dot marks tables already on the canvas.
- The grid button beside a schema ("Add all tables of this schema") puts it on the canvas. Use the search box to add one table or find a column.
- Click a table to see its details in the inspector: columns, relationships, constraints, indexes.
- **Layout** arranges tables (hierarchical, grouped by connected tables, compact, or a plain grid).
- **Explore** can focus on the selected table and the tables within 1 to 5 relationships of it, dimming or hiding the rest. **Filters** hides schemas, views or relationship types.

## 4. Keep and share

- Layouts are saved automatically for saved connections and restored when you reconnect.
- **Export** saves a PNG or SVG. These images show table and column names, so share them only with people who should see your schema.

## When something goes wrong

| You see                                    | Try                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| "needs Node.js 20.9 or newer"              | Install a current LTS version from nodejs.org.                                               |
| "Port ... is already in use"               | Omit `--port` (a free one is chosen) or pick another.                                        |
| "Open DataCanvas with the link printed..." | You opened the address without the token. Use the link the command printed.                  |
| Authentication failed                      | Check the user name and password.                                                            |
| Could not reach the database               | Check host and port, and that the server accepts connections from your computer.             |
| Encryption (SSL) error                     | The server may not offer TLS. Choose the matching encryption option.                         |
| Connecting from a container                | `localhost` inside a container is the container. Use the host's address or the service name. |

Your files are in `~/.datacanvas`. Set `DATACANVAS_HOME` to use another folder.
