---
title: Command-line reference
description: Every flag of the datacanvas command, its startup order, and how it shuts down.
---

```text
datacanvas [options]

  --port <number>   Port to listen on (default 4747, or the next free port)
  --no-open         Do not open the browser automatically
  --enable-writes   Allow editing rows and changing table structure on local databases (off by default)
  -v, --version     Print the version
  -h, --help        Show help
```

Options are parsed with Node's `util.parseArgs` in **strict** mode: an unknown flag is an error, not
silently ignored. When using `npx`, add them after the package name:
`npx --yes @shubhamtiwari909/datacanvas --port 4900 --no-open`. From a repository clone, pass them
after `--`: `npm run app -- --port 4900`.

## Flags

### `--port <number>`

Must be a whole number from 1 to 65535. An explicit port that is busy is an error. Without the flag,
DataCanvas tries 4747 and quietly falls back to the next free port. Passing a port that differs from an
already-running instance starts a new instance on that port.

### `--no-open`

Print the link but do not launch a browser. The launcher otherwise uses the operating system opener
(`open`, `xdg-open`, or `cmd /c start`); the link is always printed anyway.

### `--enable-writes`

Allows the _possibility_ of editing; it does not unlock anything by itself. You must also connect to a
database on this machine and unlock the connection by typing its name. See
[Editing rows and tables](/guides/editing/). At every start with this flag the CLI prints:

> Writes are enabled. Changes are committed immediately and cannot be undone. Connect with a role that
> can only do what you need.

The flag is the only way to turn writes on: the launcher passes `DATACANVAS_ENABLE_WRITES=1` to the
server **only** when the flag is given and removes any inherited value, so an environment variable in a
shell profile cannot enable it.

If a DataCanvas is already running with a _different_ write mode than you asked for, the launcher
refuses and tells you to stop it and start again, rather than open an instance that behaves differently
from what you expect.

## Startup order

1. Check the Node.js version (20.9 or newer).
2. Parse arguments.
3. Locate the bundled `web/apps/web/server.js` next to the CLI.
4. Create the data folder on first run (mode `0700`) and print a one-line welcome.
5. Look for a running instance (`run.json`, with a live process answering `/api/health` as DataCanvas)
   and, if found, open it instead.
6. Choose the port.
7. Start the server as a child process on `127.0.0.1` with a fresh 32-byte session token.
8. Wait for `/api/health`, write `run.json` (port, token, pid, version, writes), print the link, and
   open the browser.

## Shutdown

On Ctrl+C or `SIGTERM` the CLI stops the server (`SIGTERM`, then `SIGKILL` after 5 seconds), removes
`run.json`, and exits. The server closes every database session and forgets credentials within about
3 seconds through the hook in `apps/web/instrumentation.ts` and `lib/server/shutdown.ts`. If the server
dies on its own, the CLI reports the exit code and exits non-zero. A `kill -9` of the CLI leaves the
server running until you stop it by hand (a documented limit).

## Exit behaviour

| Situation                                                              | Result                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| Unsupported Node                                                       | Message and exit 1                                          |
| Unknown flag                                                           | Error plus help text, exit 1                                |
| Busy explicit port                                                     | `Port N is already in use…`, exit 1                         |
| Bundled server missing (running the CLI from source without packaging) | Message to run `npm run package`, exit 1                    |
| Server not ready in time                                               | Stopped, `The server did not become ready in time.`, exit 1 |

---

**Sources:** [`packages/cli/src/index.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/index.ts),
[`packages/cli/src/web-server.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/web-server.ts),
[`packages/cli/src/instance.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/instance.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Phase 11).
