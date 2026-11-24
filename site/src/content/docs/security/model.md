---
title: Security model
description: The design promises DataCanvas makes, how each one is enforced, and the honest caveat that it has had no independent review.
---

:::caution[No independent review]
DataCanvas has **not** had a review by a person or an outside firm. The code that changes data (1.5.2),
the code that runs SQL you type (1.6.0), the code that writes migrations (1.7.0), the read paths added in
1.8.0, the write paths added in 1.9.0 and the code added in 1.10.0 (the Content-Security-Policy, the plan
viewer, statistics, documentation files, INSERT scripts and chosen rows) were each read by a **second
reviewer, a separate model session** working only from the code, and what it found was fixed or written down
in the threat model. The reading door for Claude (1.11.0) is described in section 13 of the threat model; **Unknown:**
this site found no statement of a separate review of it. Nothing here
is a guarantee that it is "completely secure". Read [Known limits](/security/limits/).
:::

## The promises

| Promise                                                                                                                                          | How it is enforced                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything runs locally and listens on `127.0.0.1` only.                                                                                         | The CLI starts the server with `HOSTNAME=127.0.0.1`; a rule test fails if the CLI ever mentions an all-interfaces address.                                                                                                                                                                                                                                                                                                         |
| By default only **metadata** is read.                                                                                                            | Row-reading methods are called only by the connection service, and only after a per-connection `dataAccess` check. Rule tests fail if any other file calls them.                                                                                                                                                                                                                                                                   |
| Rows are never saved, logged, cached, or put in a snapshot, workspace or error.                                                                  | The row path has no `console.` calls (tested); stores, autosave and canvas code cannot see row types (tested); errors from the database are mapped to fixed sentences.                                                                                                                                                                                                                                                             |
| The database password lives in memory only.                                                                                                      | The registry keeps it inside the adapter; the browser only ever receives a summary with `hasPassword`. Route tests send a distinctive password through every endpoint and assert it appears in no response.                                                                                                                                                                                                                        |
| DataCanvas never changes your database unless started with `--enable-writes`, on a local-looking host, and unlocked by typing the database name. | Three independent checks in the write service, in a fixed order; see [Writes, SQL and migrations](/security/risky-features/).                                                                                                                                                                                                                                                                                                      |
| There is no endpoint that runs arbitrary SQL, except the one route of the SQL tab, which is read-only.                                           | A rule test asserts exactly one route reaches the SQL service and it is `run`. (Since 1.11.0 the MCP service, if you share a connection at the data level, calls the **same** read-only runner: no new way to run SQL.)                                                                                                                                                                                                            |
| Other websites and other programs cannot use the local server.                                                                                   | Host check, Origin and `Sec-Fetch-Site` check, a per-run session token in an `HttpOnly` `SameSite=Strict` cookie, repeated inside every route. See [Protecting the local server](/security/local-server/).                                                                                                                                                                                                                         |
| No telemetry, no cloud, no account.                                                                                                              | Framework telemetry is switched off at start-up (the CLI sets this when starting the server). DataCanvas holds no API key and calls no cloud service.                                                                                                                                                                                                                                                                              |
| Text in a page cannot run as a script (1.10.0).                                                                                                  | A Content-Security-Policy with a nonce made for each page request: no inline script, handler or `eval`, connections only to its own server, no framing. See [Protecting the local server](/security/local-server/).                                                                                                                                                                                                                |
| Claude reads nothing until you share a connection, and cannot change anything (1.11.0).                                                          | A separate door (`POST /mcp`) with its own token, a Host check and a refusal of web pages; eight read-only tools pinned by a test; approval, Pause and a rate limit that only the cookie-guarded app can control. See [Letting Claude read a connection](/security/risky-features/#letting-claude-read-a-connection-1110). **What Claude reads leaves the machine through the Claude app; that is not a control but the purpose.** |

## Defence in layers

```text
Browser ── same-origin requests with cookie ──▶ proxy.ts (Host · Origin · token;
                                                  pages: Content-Security-Policy with a nonce)
                                                  │
                                                  ▼
                                   route handler: handleRoute() repeats the checks
                                                  │ parseJsonBody (strict Zod)
                                                  ▼
                                   service (data-access gate, write gate, limits)
                                                  │
                                                  ▼
                                   adapter (read-only transaction, bound parameters)
                                                  │
                                                  ▼
                                              PostgreSQL
                                                  ▲
Claude app ── datacanvas mcp (stdio) ── POST /mcp ┘  (its own token and guard; McpService:
                                                      level, approval, pause, rate limit,
                                                      then the same services: SQL runner, page reader)
```

The lower you go the narrower the capability: the adapter's ordinary methods run in `BEGIN READ ONLY`
with a statement timeout, the SQL runner uses a connection of its own, and the write path is a separate
interface (`WritableAdapter`) that only the write service may use.

## Rules written as tests

The repository turns many of these promises into failing tests so they cannot be broken quietly:

- `tests/architecture.test.ts`: `database-core` declares no dependencies and imports only relative
  modules; `canvas-engine` is framework-free.
- `tests/security.test.ts`: every route is guarded and has `proxy.ts` in front; exactly one route takes SQL
  text; the MCP door has its own guard and the cookie guard never reads an `Authorization` header; the MCP
  files do not log, and the data tools reach data only through the services that guard it; rows, cells, validation, pre-flight and export are reachable only through the connection service
  behind the data-access check; no CORS headers; no all-interfaces address; bulk changes are single-row
  changes in one transaction; documents keep their wording.
- `tests/data-dir.test.ts`: the CLI and the web app resolve the data folder identically.

## What to do for your database

- Use a **read-only database user** with the least access that is useful. If you edit with DataCanvas, use
  a role that can change only the tables you mean to change, on a local development database.
- Use **TLS with certificate verification** when the database is not on your own machine.
- DataCanvas sets connection and statement timeouts and limits the size of everything it reads. The role
  is still the real control for what can be read and done.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting on the repository (the **Security** tab,
then **Report a vulnerability**). Do not open a public issue with exploit details.

---

**Sources:** [`SECURITY.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/SECURITY.md),
[`docs/threat-model.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/docs/threat-model.md),
[`tests/security.test.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/tests/security.test.ts),
[`tests/architecture.test.ts`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/tests/architecture.test.ts),
[`README.md`](https://github.com/ShubhamTiwari909/pg-visualizer/blob/main/README.md).
The diagram is a summary (**Inference**) of the layers described in `docs/architecture.md` (Phases 5, 6 and 10).
