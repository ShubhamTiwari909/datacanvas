---
title: Troubleshooting
description: Common messages when starting DataCanvas or connecting, and what to try.
---

| You see                                                          | Try                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "needs Node.js 20.9 or newer"                                    | Install a current LTS version from nodejs.org.                                                                                                                 |
| "Port … is already in use"                                       | Omit `--port` (a free one is chosen) or pick another.                                                                                                          |
| "Open DataCanvas with the link printed…"                         | You opened the address without the token. Use the link the command printed.                                                                                    |
| "DataCanvas is already running WITH writes enabled" (or without) | The running instance's write mode differs from the flag you passed. Stop it with Ctrl+C in its window and start again.                                         |
| Authentication failed                                            | Check the user name and password.                                                                                                                              |
| "The host is a Unix socket path"                                 | The string points at a socket (`/cloudsql/...`). See [Cloud databases and TLS](/guides/cloud-databases/).                                                      |
| Could not reach the database                                     | Check host and port, and that the server accepts connections from your computer.                                                                               |
| Encryption (SSL) error                                           | The server may not offer TLS, or its certificate is not trusted by your Node.js. Choose the matching encryption option.                                        |
| Connecting from a container                                      | `localhost` inside a container is the container. Use the host's address or the service name.                                                                   |
| Rows are not shown                                               | **Allow viewing table data** is off for this connection (the default). Switch it on.                                                                           |
| The SQL tab says it needs data viewing                           | Same: a result is rows, so viewing must be on.                                                                                                                 |
| No Writes control in the sidebar                                 | DataCanvas was not started with `--enable-writes`, or the connection is not to `localhost`/`127.x`/`::1`.                                                      |
| A column shows dots                                              | It is **hidden** because its name looks sensitive. Press **Show** in its header.                                                                               |
| A sort button is missing on a column                             | Hover for the reason: the column is hidden, the table has no key, or the type has no useful order.                                                             |
| A read was stopped after 5 seconds                               | A sort or filter on an unindexed column of a large table. Use an indexed column.                                                                               |
| Rows busy / SQL busy / Export busy                               | Another read, statement or export is running on that connection. Wait or cancel it.                                                                            |
| Claude says "DataCanvas is not running" (or "Start DataCanvas")  | Start DataCanvas, connect a database and press **Share with Claude**. See [Use DataCanvas from Claude](/guides/use-with-claude/#troubleshooting).              |
| A statement of Claude was refused, or waits                      | At the data level each call waits for your **Approve** (two minutes); **Pause** refuses everything. Look for the prompt in DataCanvas.                         |
| An **Explain as a tree** shows no tree                           | The plan was not JSON or is larger than 2 MB; switch to **JSON text** or explain a smaller query. See [The SQL tab](/guides/sql/#explain-and-the-plan-viewer). |
| A preview expired                                                | A preview can be applied once and lasts five minutes. Preview again.                                                                                           |
| "The server did not become ready in time"                        | The bundled server failed to start. Check that nothing else holds the port and try again.                                                                      |

Your files are in `~/.datacanvas`. Set `DATACANVAS_HOME` to use another folder.

If something looks like a bug, open an issue using the templates in the repository's `.github/ISSUE_TEMPLATE`
folder. **Report vulnerabilities privately** through GitHub's private vulnerability reporting
(see [Known limits](/security/limits/)).

---

**Sources:** [`docs/getting-started.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/getting-started.md) (When something goes wrong),
[`packages/cli/src/index.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/index.ts),
[`packages/shared-types/src/api-error.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/shared-types/src/api-error.ts).
