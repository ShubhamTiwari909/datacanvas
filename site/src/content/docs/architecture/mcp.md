---
title: MCP server
description: "How Claude reads a shared connection (1.11.0): the pure protocol package, the /mcp door and its token, McpService, the control state, the cookie-guarded routes and the eight tools with their limits."
---

Since 1.11.0 a Claude app can read a connection that you share, over the Model Context Protocol (MCP). The
design is `docs/mcp-server-plan.md` and decision 169; the user-facing description is
[Use DataCanvas from Claude](/guides/use-with-claude/), the security reasoning is in
[Letting Claude read a connection](/security/risky-features/#letting-claude-read-a-connection-1110).

```text
Claude app ─stdio─▶ datacanvas mcp (bridge) ─POST /mcp + Bearer token─▶ proxy.ts + route (evaluateMcpRequest)
                                                                          │
                                                                          ▼
                                                          McpService.handle ─▶ packages/mcp (JSON-RPC, tools/list, tools/call)
                                                                          │  every tool wrapped by track():
                                                                          │  pause → rate limit → approval → tool
                                                                          ▼
                                       structure: ConnectionRegistry.use(adapter)    data: SqlService.run / ConnectionService.getRows
```

## `packages/mcp`: the protocol, and nothing else

`@datacanvas/mcp` is a **private workspace package** (`apps/web` depends on it) with a single dependency,
`zod`. It is a hand-written subset of MCP, **tools only**:

- **JSON-RPC 2.0** (`jsonrpc.ts`) and four methods (`protocol.ts`): `initialize`, `ping`, `tools/list`,
  `tools/call`. Any other method is "method not found". The server declares no resources, prompts or logging.
  Notifications are accepted with `202` and no body. A batch holds at most **20** messages.
- **Protocol versions** `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`; a client asking for another
  gets the newest.
- **Tools are data** (`tools.ts`): a name, a title, a description written for a model, a **strict** zod input
  schema (an unknown field is refused), annotations (`readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: false`) and a `run` function. Because the list is data, a test can
  pin it.
- **Errors.** A tool's argument error or failure is a tool **result** with `isError` (so the model can
  correct itself); an unknown tool, or one not offered to this caller, is JSON-RPC `-32602`. Only a
  `ToolError` carries words for the model; anything else is the fixed sentence "The tool failed." Error
  answers repeat nothing the client sent: for bad arguments they name the field and the kind of problem,
  never the value.
- **Size.** One answer (text and structure together) larger than **200,000 characters** is refused, never cut
  in the middle.
- The package has **no network, framework, database or React** import: `tests/architecture.test.ts` checks
  that every import is relative or `zod` and that there is no `fetch(`, `node:http`, `node:net` or
  `process.`. The official `@modelcontextprotocol/sdk` (1.32.2 in the root `package.json`) is used by the
  tests as a client, not by the server.

## The door: `POST /mcp`

`apps/web/app/mcp/route.ts` is **stateless Streamable HTTP in its simplest form**: each request is one
JSON-RPC message (or a batch), each answer one `application/json` body, no session id and no stream. `GET`
and `DELETE` answer 405. Responses carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

Guard, in order (`evaluateMcpRequest` in `request-guard.ts`, called in `proxy.ts` and again in the route):

1. No MCP token configured: **404**.
2. Host check (`127.0.0.1:<port>` or `localhost:<port>`): 403.
3. An `Origin` or `Sec-Fetch-Site` header (a browser): 403. `Sec-Fetch-Mode` is deliberately not checked,
   because Node's own `fetch` sends `cors` there.
4. `Authorization: Bearer <token>`, compared in constant time: 401.

Then, in the route: **404 while no connection is shared**, before the body is read; then
`parseJsonBody(request, z.unknown(), 256 KB)`; then `McpService.handle`. See
[Protecting the local server](/security/local-server/) for the security reasoning.

### The token and where it travels

- The CLI makes the **MCP token** for each run (`generateSessionToken()`: 32 random bytes, base64url, a
  different secret from the session token) and starts the server with it in **`DATACANVAS_MCP_TOKEN`**. Any
  value of that variable inherited from the shell is deleted first. If the value equals the session token,
  `readSecurityConfig` treats it as no token (the route then does not exist).
- It is accepted **on `/mcp` only**. The cookie guard never reads an `Authorization` header, so the token
  opens nothing in the app.
- The CLI writes `mcp.json` (`{ pid, port, token }`, mode `0600`) to the data folder after the server is
  healthy, and deletes it on a clean shutdown (only if it still describes this process). The **bridge**
  `datacanvas mcp` reads it **for every message**, so a restart of DataCanvas needs no change to the Claude
  app's config. See [CLI and packaging](/architecture/cli-and-packaging/).

## `McpService`: the one place that decides what a tool may reach

`apps/web/lib/server/mcp-service.ts` is the only file that calls the services on behalf of MCP. A rule test
checks that it imports nothing that writes. It holds, **in memory only**:

- the **level** of each shared connection (`structure` or `data`; absent means off) and the **approval**
  choice (on by default). `levelOf` falls back from `data` to `structure` when viewing table data is
  switched off; a disconnect (`ConnectionRegistry.onRemove`) stops the sharing.
- the **tool list**: the three data tools are offered to a caller only while `anyData()` is true.
- `share(id, level, { acknowledgeRole, approval })`: refuses the data level without data access
  (`data_access_disabled`), and for a **superuser or a role in `pg_read_server_files`,
  `pg_write_server_files` or `pg_execute_server_program`** throws `claude_role_not_acknowledged` (409) unless
  `acknowledgeRole` is true. A failure to read the role does not block.
- `handle(body, signal)`: 404 when nothing is shared, otherwise the protocol package.
- `structure(connection, read)`: runs a read of the structure through `ConnectionRegistry.use` and turns every
  failure into fixed words ("There is no such table or schema.", "The database could not be read right
  now."): **the database's own message is never used**. A connection that is not shared, paused or gone gives
  one sentence for all of them.
- `runQuery`: refuses a statement that **names a sensitive-looking column** (`sensitiveNamesIn`), then calls
  **`SqlService.run`** (a read-only transaction on a connection of its own, one statement, limits).
- `readRows`: calls **`ConnectionService.getRows`** with `revealColumns: []` (there is no reveal in any input).

Every tool is wrapped by **`track`**, in a fixed order: record the call in the activity list, **paused?**,
**rate limit?**, then (data tools on a data-level connection with approval on) **wait for Approve**, then run
the tool and record rows and size. A rule test pins this order.

### `mcp-data.ts`: what may be said and how a result is cut

Pure functions, so each rule is a unit test: `sensitiveNamesIn` (comments, strings and dollar-quoted text are
not looked into; a quoted identifier is read without its quotes; at most five names), `failureWords` (the
database's sentence only for SQLSTATE class `42`, `57014`, class `54`, and DataCanvas's own `not_allowed` and
`cancelled`; every other code becomes "The database refused the statement (SQLSTATE …)…"), `shapeQueryResult`
and `shapePage` (hidden columns NULL, cells cut at 500 characters, rows fitted into 100,000 characters).

### `mcp-control.ts`: the activity list, approvals, pause and rate limit

`McpControl` is pure state with an injectable clock, in memory only: the **activity list** (the last 200
calls, newest first; each entry has an id, time, tool, connection id and name, the request text cut at 2,000
characters, the outcome and the counts of rows and characters; **never a returned value**, a rule test pins
the fields), the **waiting approvals** (each resolves `approved`, `denied`, `timeout` after **2 minutes** or
`aborted` when the client gives up), the **pause** (which denies the waiting approvals) and the **rate
limit** (30 calls in a sliding minute, for all connections together). When nothing is shared any more
(`stop` of the last connection) the list, the pause and the count are cleared.

Outcomes: `waiting`, `ok`, `error`, `refused`, `not_approved`, `paused`, `rate_limited`.

## The routes behind the cookie

The person's side is ordinary `/api` routes, so they have the cookie guard, `handleRoute` and strict schemas.
**Nothing on the MCP path can reach them** (rule test), and the token of `/mcp` is refused on them.

| Route                                   | What                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET`/`PUT /api/connections/:id/claude` | Read or set `{ level: "off" \| "structure" \| "data", acknowledgeRole?, approval? }`; answers `{ sharing: { level, approval } }`. |
| `GET /api/claude/activity`              | `{ paused, shared[], pending[], activity[] }`: the state for the screen.                                                          |
| `POST /api/claude/pending/:id`          | `{ decision: "approve" \| "deny" }`; 404 `not_found` when nothing waits by that id any more.                                      |
| `PUT /api/claude/pause`                 | `{ paused: boolean }`.                                                                                                            |

In the browser: `features/claude` (the sidebar control, the share dialog, the approval prompt mounted once in
the app shell and the setup text) and `stores/claude-store.ts`, which **polls the activity route every 1.5
seconds only while something is shared** and takes its state from the answer, so a sharing the server forgot
disappears from the screen too. The approval prompt ignores Escape and a click outside.

## The eight tools and their limits

All have a strict input schema, the read-only annotations, and are wrapped by `track`.

| Tool                 | Level     | Input                                                                                  | Limits (verified in code)                                                                                                                                                                                                                 |
| -------------------- | --------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_connections`   | structure | none                                                                                   | Only shared connections; id, name, database, level. No host, user or password.                                                                                                                                                            |
| `list_schemas`       | structure | `connection`                                                                           | Counts of tables and views per schema.                                                                                                                                                                                                    |
| `list_tables`        | structure | `connection`, `schema`, `cursor?`                                                      | **500** a call (`LIST_TABLES_PAGE`); the cursor is a number up to 6 digits.                                                                                                                                                               |
| `describe_table`     | structure | `connection`, `schema`, `table`                                                        | One table; columns carry `hidden`, null fraction and distinct figures when statistics exist.                                                                                                                                              |
| `search_objects`     | structure | `connection`, `query` (1 to 100 characters)                                            | **50** results (`SEARCH_RESULTS`); names only.                                                                                                                                                                                            |
| `read_rows`          | data      | `connection`, `schema`, `table`, `filters?` (max 10), `sort?`, `cursor?`, `page_size?` | `page_size` 1 to **100**, default 50; cells cut at **500** characters; rows fitted into about **100,000** characters.                                                                                                                     |
| `run_readonly_query` | data      | `connection`, `sql` (1 to 20,000 characters), `max_rows?`, `timeout_seconds?`          | `max_rows` 1 to **1,000**, default 200; `timeout_seconds` 1 to **30**, default 10; cells **500**; about **100,000** characters.                                                                                                           |
| `explain_query`      | data      | `connection`, `sql` (1 to 20,000 characters)                                           | Runs `EXPLAIN (FORMAT JSON)` through the same runner (10 s), never `ANALYZE`. The plan is returned whole (the runner keeps a plan up to 2 MB); the protocol's 200,000-character limit applies; the text copy is cut at 20,000 characters. |

Common to every call: connection id 1 to 64 characters; names 1 to 255 characters; the request body at most
256 KB.

**Not in this version:** MCP resources and prompts, `read_rows` by a list of keys, a paths tool, and anything
that needs a session.

---

**Sources:** [`packages/mcp/src/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/packages/mcp/src) (`protocol.ts`, `jsonrpc.ts`, `tools.ts`),
[`apps/web/app/mcp/route.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/app/mcp/route.ts),
[`apps/web/proxy.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/proxy.ts),
[`apps/web/lib/security/request-guard.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/security/request-guard.ts),
[`apps/web/lib/server/mcp-service.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/mcp-service.ts),
[`apps/web/lib/server/mcp-control.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/mcp-control.ts),
[`apps/web/lib/server/mcp-data.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/lib/server/mcp-data.ts),
[`apps/web/app/api/claude/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/app/api/claude),
[`apps/web/app/api/connections/[id]/claude/route.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/apps/web/app/api/connections/%5Bid%5D/claude/route.ts),
[`apps/web/features/claude/`](https://github.com/ShubhamTiwari909/pg-visualizer/tree/main/apps/web/features/claude),
[`packages/cli/src/mcp-bridge.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/mcp-bridge.ts),
[`packages/cli/src/mcp-file.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/packages/cli/src/mcp-file.ts),
[`tests/architecture.test.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/tests/architecture.test.ts),
[`docs/mcp-server-plan.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/mcp-server-plan.md),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/architecture.md) (Claude reading a connection).
Where the plan's section 4 gives other numbers (page of 200, a plan of 1 MB), the code was followed.
