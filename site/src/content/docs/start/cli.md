---
title: Command-line reference
description: Every flag of the datacanvas command, its startup order, and how it shuts down.
---

```text
datacanvas [options]
datacanvas mcp                A bridge for a Claude app (read only)
datacanvas schema check --baseline <file> [--format markdown|json]

  --port <number>   Port to listen on (default 4747, or the next free port)
  --no-open         Do not open the browser automatically
  --host <address>  127.0.0.1 (default) or 0.0.0.0 (a container only: needs DATACANVAS_ALLOW_ANY_INTERFACE=1)
  --enable-writes   Allow editing rows and changing table structure on local databases (off by default)
  -v, --version     Print the version
  -h, --help        Show help
```

Options are parsed with Node's `util.parseArgs` in **strict** mode: an unknown flag is an error, not
silently ignored. When using `npx`, add them after the package name:
`npx --yes @shubhamtiwari909/datacanvas --port 4900 --no-open`. From a repository clone, pass them
after `--`: `pnpm run app -- --port 4900`.

## Check for schema drift

Export a baseline from [Snapshots](/guides/snapshots/) and commit the `.snapshot.json` file
where your workflow can read it. Set `DATACANVAS_DATABASE_URL` in your shell or workflow environment,
then run:

```sh
npx --yes @shubhamtiwari909/datacanvas@1.15.0 schema check --baseline db/baseline.snapshot.json
```

The command compares the baseline with the live database using the same comparison as the
Snapshots page. It reads catalog metadata without opening the web app. Use the same PostgreSQL
major version and a role that can see the same schema objects as the baseline connection.
Baselines can be up to 20 MiB. Reports can include object definitions, so share them with the same
audience as your schema.

The default output is Markdown. Use `--format json` for an object with a `status` and the
structured `diff`. For input or connection errors, the command writes a message to stderr.

| Exit code | Meaning                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `0`       | The compared schema matches the baseline (`match`).                                             |
| `1`       | The check found changes (`drift`).                                                              |
| `2`       | The check failed or the older baseline lacked object metadata to verify a match (`incomplete`). |

An older snapshot with recorded drift still exits `1`. The report identifies the missing
object comparison. Export a current snapshot to verify those objects.

The [GitHub Actions example](https://github.com/ShubhamTiwari909/datacanvas/blob/main/examples/github-actions/schema-drift.yml)
starts a disposable PostgreSQL service and applies `db/schema.sql` from the pull request. Copy it
to `.github/workflows/schema-drift.yml`, adjust the schema setup step for your project, and commit
your exported baseline as `db/baseline.snapshot.json`. The job fails and shows the report when
the two schemas differ. Export and review a new baseline when the change is intentional.

## Flags

### `--port <number>`

Must be a whole number from 1 to 65535. An explicit port that is busy is an error. Without the flag,
DataCanvas tries 4747 and quietly falls back to the next free port. Passing a port that differs from an
already-running instance starts a new instance on that port.

### `--host <address>`

`127.0.0.1` (the default) or `0.0.0.0`. DataCanvas listens on your own computer only; `0.0.0.0` exists for a
**container**, where a published port reaches the program through the container's own network interface. It is
accepted only when the environment variable `DATACANVAS_ALLOW_ANY_INTERFACE` is exactly `1` (the Docker image
sets it, a normal computer does not); otherwise the CLI exits with an explanation. Nothing else is loosened:
the Host check accepts only `127.0.0.1:<port>` and `localhost:<port>`, and the session token and the token of
`/mcp` are still required, so a request through a LAN address is refused. Publish the port to `127.0.0.1` of
the host only, with the same port on both sides. The full recipe is in
[docs/docker.md](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/docker.md).

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

## `datacanvas mcp`

```text
npx --yes @shubhamtiwari909/datacanvas mcp
```

The **bridge** that a Claude app starts (Claude Desktop, Claude Code, any MCP client) to reach the running
DataCanvas. You do not run it by hand: the **Share with Claude** dialog gives the text to paste into the
Claude app once, and the text never changes. See [Use DataCanvas from Claude](/guides/use-with-claude/).

- It is a **subcommand, not a flag**, and takes no options. It talks MCP over **stdio**: one JSON-RPC message
  per line in, one per line out. Nothing else is ever written to stdout; it starts no server and opens no
  browser.
- It **finds the running DataCanvas by itself**, from `mcp.json` in the data folder (it honours
  `DATACANVAS_HOME`), and forwards each message to `POST /mcp` with a token that only DataCanvas and the
  bridge know. The token changes on every run, which is why the Claude app's config never holds it.
- If DataCanvas is not running, or no connection is shared with Claude, it answers in plain words:
  "DataCanvas is not running, or no connection is shared with Claude. Start DataCanvas, connect to your
  database and switch on Share with Claude." Start `datacanvas` in another terminal and share a connection.
- If DataCanvas refuses it (after a restart of DataCanvas while the Claude app kept its session), it says to
  restart DataCanvas and the Claude app.
- It needs the same Node.js (20.9 or newer).

Everything it can reach is read-only and chosen by you in the app. See
[CLI and packaging](/architecture/cli-and-packaging/) for how it works.

## Startup order

1. Check the Node.js version (20.9 or newer).
2. Parse arguments.
3. Locate the bundled `web/apps/web/server.js` next to the CLI.
4. Create the data folder on first run (mode `0700`) and print a one-line welcome.
5. Look for a running instance (`run.json`, with a live process answering `/api/health` as DataCanvas)
   and, if found, open it instead.
6. Choose the port.
7. Start the server as a child process on `127.0.0.1` with a fresh 32-byte session token and a second,
   separate fresh token for `/mcp` (`DATACANVAS_MCP_TOKEN`).
8. Wait for `/api/health`, write `run.json` (port, token, pid, version, writes), print the link, write
   `mcp.json` (pid, port and the MCP token, for `datacanvas mcp`), and open the browser.

## Shutdown

On Ctrl+C or `SIGTERM` the CLI stops the server (`SIGTERM`, then `SIGKILL` after 5 seconds), removes
`run.json` and `mcp.json`, and exits. The server closes every database session and forgets credentials within about
3 seconds through the hook in `apps/web/instrumentation.ts` and `lib/server/shutdown.ts`. If the server
dies on its own, the CLI reports the exit code and exits non-zero. A `kill -9` of the CLI leaves the
server running until you stop it by hand (a documented limit).

## Exit behaviour

| Situation                                                              | Result                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| Unsupported Node                                                       | Message and exit 1                                          |
| Unknown flag                                                           | Error plus help text, exit 1                                |
| Busy explicit port                                                     | `Port N is already in use…`, exit 1                         |
| Bundled server missing (running the CLI from source without packaging) | Message to run `pnpm run package`, exit 1                   |
| Server not ready in time                                               | Stopped, `The server did not become ready in time.`, exit 1 |

---

**Sources:** [`packages/cli/src/index.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/cli/src/index.ts),
[`packages/cli/src/web-server.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/cli/src/web-server.ts),
[`packages/cli/src/mcp-bridge.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/cli/src/mcp-bridge.ts),
[`packages/cli/src/mcp-file.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/cli/src/mcp-file.ts),
[`packages/cli/src/instance.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/cli/src/instance.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Phase 11).
