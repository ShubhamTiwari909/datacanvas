---
title: Configuration
description: The command-line flags, environment variables, files and ports DataCanvas uses. There is no .env file.
---

DataCanvas needs **no configuration file and no `.env`**. The `.gitignore` even lists `.env` files with a
comment that DataCanvas needs none.

## Flags

See the [Command-line reference](/start/cli/): `--port`, `--no-open`, `--enable-writes`, `--version`, `--help`,
and the `mcp` subcommand (the bridge for a Claude app, 1.11.0).

## Environment variables

Names below were found by searching the source; values are never documented here.

| Variable                                               | Read by                     | Meaning                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATACANVAS_HOME`                                      | CLI and web app             | Use another data folder instead of `~/.datacanvas`. Set it while testing by hand so your real data is untouched.                                                                                                                                                                                                     |
| `DATACANVAS_SESSION_TOKEN`                             | web server (set by the CLI) | The per-run secret. Not for users to set.                                                                                                                                                                                                                                                                            |
| `DATACANVAS_ALLOW_ANY_INTERFACE`                       | CLI                         | Must be exactly `1` before `--host 0.0.0.0` is accepted (1.11.0). The Docker image sets it; on your own computer leave it unset. The Host check and both tokens still apply.                                                                                                                                         |
| `DATACANVAS_MCP_TOKEN`                                 | web server (set by the CLI) | The per-run secret of `POST /mcp` (1.11.0): a different secret from the session token, accepted on that one route only. The CLI makes it for each run and deletes any inherited value, so **setting it yourself does nothing**; a value equal to the session token is treated as none (and `/mcp` then answers 404). |
| `DATACANVAS_VERSION`                                   | web server (set by the CLI) | The version, read only for the `serverInfo` of the MCP server.                                                                                                                                                                                                                                                       |
| `DATACANVAS_ENABLE_WRITES`                             | web server (set by the CLI) | The server treats only the exact value `1` as writes enabled. The CLI sets it only for `--enable-writes` and deletes any inherited value, so **setting it yourself does nothing**.                                                                                                                                   |
| `NEXT_MANUAL_SIG_HANDLE`                               | set by the CLI              | Stops Next.js exiting before DataCanvas closes its connections.                                                                                                                                                                                                                                                      |
| `DATACANVAS_TEST_PG_URL`                               | tests                       | A disposable PostgreSQL for integration tests. **Never point it at a server holding data you care about.**                                                                                                                                                                                                           |
| `DATACANVAS_PROPERTY_RUNS`, `DATACANVAS_PROPERTY_SEED` | a property test             | Run count and seed for the migration property test (semantics not documented here).                                                                                                                                                                                                                                  |
| `PGSSLMODE`                                            | (not used)                  | The adapter always passes TLS settings explicitly, so this cannot weaken them.                                                                                                                                                                                                                                       |

`HOSTNAME` is set by the CLI to `127.0.0.1` for the server process. A variable named `DC_SPIKE` also appears in
the source; its purpose is **Unknown** and it is not documented.

## Files and folders

| Path                                            | Purpose                                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.datacanvas/` or `$DATACANVAS_HOME`          | Data folder (mode `0700`)                                                                                                                                   |
| `connections.json`, `workspaces/`, `snapshots/` | Saved data, files `0600`                                                                                                                                    |
| `run.json`                                      | The running instance: pid, port, token, version, writes (deleted on exit)                                                                                   |
| `mcp.json`                                      | For `datacanvas mcp` (1.11.0): pid, port and the token of `/mcp`, mode `0600`, deleted on exit. A different secret from the session token. Not for editing. |

## Ports

- Default **4747** on `127.0.0.1`; the next free port if busy; an explicit `--port` must be free.
- The development server (`npm run dev`) uses `next dev -H 127.0.0.1 -p 4747`.
- The test database in `examples/docker-compose.yml` is bound to `127.0.0.1:54329`.

## Network behaviour

The server listens only on loopback. Outbound connections go only to the PostgreSQL servers you connect to.
There is no telemetry, analytics or update check described anywhere in the repository (framework telemetry is
switched off). DataCanvas itself makes no outbound connection to Anthropic or any cloud service; if you
[share a connection with Claude](/guides/use-with-claude/), a Claude app on your machine asks the local
server and sends what it reads on.

## Supported versions

| Component                   | Version                                                       |
| --------------------------- | ------------------------------------------------------------- |
| Node.js (run the package)   | 20.9 or newer                                                 |
| Node.js (build from source) | `^20.19.0 \|\| >=22.12.0`                                     |
| npm                         | 10 or newer                                                   |
| PostgreSQL                  | 12 to 18 tested (a CI matrix runs the database tests on each) |

---

**Sources:** [`packages/cli/src/mcp-file.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/mcp-file.ts),
[`apps/web/lib/security/request-guard.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/security/request-guard.ts),
[`packages/cli/src/index.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/index.ts),
[`packages/cli/src/web-server.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/web-server.ts),
[`apps/web/lib/server/storage/data-dir.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/storage/data-dir.ts),
[`.github/workflows/ci.yml`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/.github/workflows/ci.yml),
[`examples/docker-compose.yml`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/examples/docker-compose.yml),
[`.gitignore`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/.gitignore),
[`CONTRIBUTING.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/CONTRIBUTING.md).
