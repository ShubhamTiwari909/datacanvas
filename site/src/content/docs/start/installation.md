---
title: Installation
description: Requirements, the one-command install, what DataCanvas prints on start, and how to stop it.
---

DataCanvas is a command-line launcher that starts a local web app and opens your browser. There is
no account, no cloud service, no `.env` file and no build step for users. (Only if you choose to
[share a connection with Claude](/guides/use-with-claude/) does anything read through DataCanvas leave your
machine, and then only through the Claude app you use.)

## Requirements

| You are…                      | Node.js                                 | Notes                                                                                                                              |
| ----------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Running the published package | 20.9 or newer                           | The CLI checks this at start and prints an actionable message if it is older.                                                      |
| Building from a clone         | `^20.19.0 \|\| >=22.12.0` (not Node 21) | The build tool loads an ES-module-only dependency with `require()`, which Node supports only from those versions. npm 10 or newer. |

A PostgreSQL database to connect to is the only other thing you need. Versions 12 to 18 are covered
by the project's test matrix (see [Testing](/contributing/testing/)).

## Run it

```bash
npx --yes @shubhamtiwari909/datacanvas
```

To skip `npx`, install once and run the short command:

```bash
npm install -g @shubhamtiwari909/datacanvas
datacanvas
```

The first run downloads the package (about 5 MB according to the project's guide); later runs start
from npm's cache. Add [options](/start/cli/) after the command, for example
`--port 4900 --no-open`.

## What it prints

On start the launcher creates your data folder (first run only), starts the bundled server on
`127.0.0.1`, waits until the server answers its health check, and prints a private link such as:

```text
DataCanvas is running. Open this link in your browser:
  http://127.0.0.1:4747/?token=…
The link is private to this run. Press Ctrl+C to stop.
```

- The **token** is new on every run. It is what keeps other websites and other programs out; treat
  the link like a password while DataCanvas runs. After the first page load the app swaps it for an
  `HttpOnly` cookie and removes it from the address bar.
- If you open the address **without** the token you are refused. Use the link the command printed.
- The default port is 4747. If it is taken, the next free port is used and a message says so. An
  explicit `--port` that is busy is an error.
- If DataCanvas is already running, starting it again prints and opens the running instance's link
  instead of starting a second server.

Press **Ctrl+C** to stop. The launcher signals the server, which closes every database session and
forgets all credentials (within about three seconds) before the process exits.

## Using it from a Claude app (optional)

The same package also contains `datacanvas mcp`, the bridge a Claude app starts. Install nothing extra: the
**Share with Claude** dialog gives the one line to paste into Claude Code or Claude Desktop, which runs
`npx --yes @shubhamtiwari909/datacanvas mcp`. With a global install, `datacanvas mcp` is the same command.
See [Use DataCanvas from Claude](/guides/use-with-claude/).

## Where your data lives

`~/.datacanvas` (owner-only), or the folder named by `DATACANVAS_HOME`. See
[Saved data and themes](/guides/saved-data/) and [Configuration](/reference/configuration/).

## Next

[Connect a database](/start/connect/).

---

**Sources:** [`README.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/README.md),
[`docs/getting-started.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/getting-started.md),
[`packages/cli/src/index.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/cli/src/index.ts),
[`CONTRIBUTING.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/CONTRIBUTING.md).
