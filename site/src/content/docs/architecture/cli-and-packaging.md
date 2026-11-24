---
title: CLI and packaging
description: How the one-command install is assembled, what the published package contains, and how the packed tarball is verified.
---

The product is the **packed npm package**, not the monorepo. A user runs one command and gets a CLI plus a
prebuilt web server; they never run a build.

## Runtime pieces

| Piece                                 | Role                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/cli` → `bin/datacanvas.mjs` | The launcher (bundled by esbuild into one file; `shared-types` is inlined). See [Command-line reference](/start/cli/). |
| `web/apps/web/server.js`              | The Next.js **standalone** server, started by the CLI as a child process on `127.0.0.1`.                               |
| `node_modules/` at the package root   | Server runtime dependencies (`next`, `react`, `react-dom`, …).                                                         |

The server is given its settings **through the environment**: `HOSTNAME=127.0.0.1`, the port,
`DATACANVAS_SESSION_TOKEN` (a fresh 32-byte secret), `DATACANVAS_ENABLE_WRITES=1` only when the flag was given
(any inherited value is deleted), and `NEXT_MANUAL_SIG_HANDLE=1` so Next.js does not exit before DataCanvas
closes its connections. Framework telemetry is switched off. Since 1.11.0 it also gets
**`DATACANVAS_MCP_TOKEN`** (a second fresh 32-byte secret, for `/mcp` only; any value inherited from the
shell is deleted, in every letter case) and `DATACANVAS_VERSION` (read only for the `serverInfo` of the MCP
server).

## `datacanvas mcp` and `mcp.json` (1.11.0)

`datacanvas mcp` is **not a flag**: if the first argument is `mcp`, `index.ts` hands over to
`runBridge(resolveDataDir())` straight after the Node version check and before anything that prints, because
nothing but protocol may go to stdout. It is the **stdio bridge** a Claude app starts as a command:

- It reads one line of JSON-RPC at a time from stdin and handles them **in order** (an answer never
  overtakes the one before it).
- For each line it reads **`mcp.json`** in the data folder (`{ pid, port, token }`, parsed strictly: whole
  numbers, a token of 16 to 128 URL-safe characters) and does `POST http://127.0.0.1:<port>/mcp` with
  `Authorization: Bearer <token>` and a **120 second** timeout. Reading the file for every message means a
  restart of DataCanvas needs no change in the Claude app's config.
- It prints the answer as one JSON line. A notification (`202`) prints nothing. A line over 300,000
  characters is refused.
- It has **no dependency, no state and no secret of its own**. If `mcp.json` is missing, DataCanvas is not
  reachable or the route answers 404, it answers a JSON-RPC error in plain words: _"DataCanvas is not running,
  or no connection is shared with Claude. Start DataCanvas, connect to your database and switch on Share
  with Claude."_ On 401 or 403: _"DataCanvas refused this program. Restart DataCanvas and the Claude app,
  then try again."_

**`mcp.json`** (`packages/cli/src/mcp-file.ts`) is the same class of file as `run.json`: mode `0600`, written
after the server is healthy, deleted on a clean shutdown only if it still describes this process, and a
leftover from a crash is useless because the token died with the process. It holds **only** what the bridge
needs, and the MCP token is a **different secret** from the session token in `run.json`.

## Single-instance behaviour

`instance.ts` reads `run.json` in the data folder (port, token, pid, version, writes; mode `0600`). If that
process is alive **and** `/api/health` answers as DataCanvas, the CLI opens the running instance's private
link and exits. Stale files (after a crash) are ignored. A running instance whose write mode differs from the
flag is refused, not reused. `cli/src/data-dir.ts` repeats the web app's data-folder resolver on purpose (the
CLI is bundled alone); `tests/data-dir.test.ts` fails if they disagree.

## `npm run package` → `.package/`

`scripts/build-package.mjs` runs after the normal build and assembles:

```text
.package/
├── bin/datacanvas.mjs      CLI bundle
├── web/apps/web/           standalone server.js, .next/server and .next/static
├── node_modules/           server runtime deps lifted to the package root
├── package.json            generated (name, version, bin, engines, license, repository, bugs, bundleDependencies)
└── README.md, LICENSE, NOTICE, THIRD-PARTY-NOTICES.md
```

Problems the script solves (each commented in the script and in `docs/architecture.md`):

1. **`sharp` is shipped even with unoptimised images.** The standalone tracer copies the native image library
   and a platform binary. The script prunes `sharp`, `@img`, `@emnapi` and `detect-libc`, then **fails the
   build if any `.node` file remains**.
2. **`npm pack` drops nested `node_modules`.** Runtime dependencies are moved to the package root and declared
   in both `dependencies` and `bundleDependencies`; Node still finds them by walking up from `server.js`.
3. **The CLI imports a workspace package that does not exist on npm.** esbuild bundles it.
4. **Turbopack hashed aliases are symlinks.** Turbopack refers to `pg` by an alias like `pg-587764f78a6c7a9c`
   provided as a symlink, which `npm pack` drops, so the script replaces each with a real shim package that
   re-exports the real one.

Guard rails: no native add-ons, and bundled packages must not define install scripts. The published package
declares **no install scripts** and `engines.node` (the CLI itself requires 20.9+).

## `npm run verify:package`

Packs the tarball, installs it into an empty project, and exercises the installed command (22 checks per the
project's notes, including token protection, instance reuse and clean shutdown), printing tarball size and
cold-start time. CI runs it on macOS, Linux and Windows with Node 20.9.0 and 22 (build always on Node 22).

## Release gate

`npm run release:check` (`scripts/release-check.mjs`) inspects the assembled package and the repository and
lists **every** blocker: package name pattern, a real version (not `0.0.0`), `license`, `LICENSE`,
`repository`, `bugs`, `engines.node`, `bin.datacanvas`, no `preinstall`/`install`/`postinstall` scripts,
`NOTICE` and `THIRD-PARTY-NOTICES.md`, and a changelog section. It reports and never fills in decisions that
belong to the maintainer. See [Releasing](/contributing/releasing/).

---

**Sources:** [`packages/cli/src/`](https://github.com/ShubhamTiwari909/datacanvas/tree/main/packages/cli/src) (`index.ts`, `mcp-bridge.ts`, `mcp-file.ts`, `web-server.ts`),
[`scripts/build-package.mjs`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/scripts/build-package.mjs),
[`scripts/release-check.mjs`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/scripts/release-check.mjs),
[`scripts/verify-package.mjs`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/scripts/verify-package.mjs),
[`.github/workflows/ci.yml`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/.github/workflows/ci.yml),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Phases 2, 11, 13).
The "22 checks" figure and the `NEXT_MANUAL_SIG_HANDLE` detail come from `docs/architecture.md`; the release-gate list was read
from only the first part of `release-check.mjs`, so later checks (including the changelog section) are taken from the docs.
