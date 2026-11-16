# Threat model (Phase 10)

A short, honest model of what DataCanvas protects, from whom, and where it stops. Review it whenever a feature adds a route, a file, or a network call.

## Assets (what we protect)

| Asset                                    | Why it matters                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Database credentials                     | Give access to the user's data.                                                                                  |
| Schema metadata                          | Table and column names reveal how a system works.                                                                |
| Open database connections                | Whoever can call the API can use them (read metadata, and rows where data viewing is on).                        |
| Table contents (when data viewing is on) | The most sensitive asset: whoever can call the API with the token can read rows of tables on an open connection. |
| Saved files (`~/.datacanvas`)            | Connection details (no password) and layouts.                                                                    |

## Attackers and what they can try

### 1. A malicious website open in the user's browser

| Attempt                                                   | Control                                                                                                                                                                                                                                                                                                            | Residual                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `fetch("http://127.0.0.1:4747/api/...")` to read metadata | No CORS headers: the browser hides the response. `Sec-Fetch-Site: cross-site` is refused. Cookie is `SameSite=Strict`. Token required.                                                                                                                                                                             | None known.                                                                                   |
| Forged form or fetch that changes state (connect, delete) | Origin check; JSON-only bodies (a plain HTML form cannot send them); token.                                                                                                                                                                                                                                        | None known.                                                                                   |
| DNS rebinding: attacker domain resolves to 127.0.0.1      | Host check accepts only `127.0.0.1:<port>` and `localhost:<port>`.                                                                                                                                                                                                                                                 | None known.                                                                                   |
| Embedding the app in a frame (clickjacking)               | `frame-ancestors 'none'` and `X-Frame-Options: DENY`.                                                                                                                                                                                                                                                              | None known.                                                                                   |
| Calling the rows endpoint, or switching data viewing on   | Everything above (Host, Origin, `Sec-Fetch-Site`, token, no CORS), checked in the front door and again in the route. The per-connection opt-in is off by default and is read before anything about the table is looked up, so a refused connection answers the same for a table that exists and one that does not. | Anyone holding the token can switch data viewing on: the same trust as before, higher stakes. |
| Guessing the token                                        | 256-bit random value, constant-time comparison.                                                                                                                                                                                                                                                                    | None practical.                                                                               |

### 1b. Rows leaving by a side door

| Attempt                                        | Control                                                                                                                                                                                                                                         | Residual                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Rows in logs                                   | Only error codes are logged, never bodies, cursors or rows. A rule fails the build if the data viewer uses `console`.                                                                                                                           | None known.                                                                        |
| Rows in error messages                         | Raw database messages are never returned (they can contain values). A forged paging position gets a fixed message that does not repeat it.                                                                                                      | None known.                                                                        |
| Rows saved to disk                             | Not in workspaces, snapshots, `run.json` or profiles. A rule fails if the data viewer or the stores touch `localStorage`, `sessionStorage`, `indexedDB`, cookies or caches, and a browser test checks the browser storage after rows were read. | The browser's own memory, and the operating system's swap.                         |
| Rows cached                                    | `Cache-Control: no-store`. Reads are `POST`, so a table name and a paging position are never in a URL, the history or a log.                                                                                                                    | Browser extensions with access to the page.                                        |
| A secret shown by accident                     | Columns whose names look sensitive are not selected at all; the server never sends them unless the person reveals that column for the current view. A browser test checks the value is nowhere in the page.                                     | Names are only a hint: a column called `notes` can hold a password.                |
| Shoulder surfing or screen sharing             | A **Blur values** switch, held in memory only.                                                                                                                                                                                                  | It is for that purpose only: it does not change what is read, copied or announced. |
| A query that hurts the database                | Read-only transaction, statement timeout, row, column, cell and response caps, one read at a time (three waiting, then `429`), keyset paging, capped `OFFSET` for tables without a key.                                                         | A slow view or a heavy table still costs the database up to the timeout.           |
| SQL injection through names, cursors or values | The statement has one shape. Names come from the catalog and are quoted; the page size, the cell limit and the cursor are bound parameters. Tested on a fixture of awkward names.                                                               | None known.                                                                        |
| Rows hidden by row-level security              | The page says whether security applies to the connected role, and the Data section shows a note when it does.                                                                                                                                   | The check judges role membership approximately, so the wording says "may".         |

### 2. A web app on another port of 127.0.0.1

Cookies are shared across ports, so it receives the cookie when the browser visits it. From a browser it still cannot call our API (Origin / `Sec-Fetch-Site` checks, no CORS). **Residual:** its _server side_ could replay the cookie; that is a hostile local program (next).

### 3. Another program on the machine

- Other users: the server listens on loopback and requires the token; a different user cannot normally see the token. **Residual:** a hostile administrator.
- While DataCanvas runs, the token is also in `~/.datacanvas/run.json` (mode 0600) so a second launch can reopen the running instance. It is deleted on clean shutdown; a stale file is useless because the token dies with the process.
- Same user: can read the process environment and the CLI output, and can read `~/.datacanvas`. **Out of scope:** this attacker already controls the account. We still keep the password out of every file, so even they find no password at rest.

### 4. Someone who gets a diagram, workspace file or snapshot file

Contains table and column names, and never row data, whether or not data viewing is on (a snapshot also column types, defaults, comments, index and constraint definitions, view queries, function and trigger bodies, and row-level-security policy expressions and role names, which can describe business logic and access rules) but no row data and no connection credentials. Definitions are copied exactly as written, so they can contain secrets someone typed into them (a literal key in a function body, a password in a view's query); an exported file carries them along, and DataCanvas does not scan for them. The export dialog and the Snapshots tab say so. Imported workspace and snapshot files are validated (unknown keys refused, every list and string bounded), size-limited, and can never overwrite existing data: an imported snapshot always gets a new id.

### 5. Hostile input

Every request body and query string is validated with a schema, size-limited, and answered with fixed messages. Identifiers are validated before touching the file system (no path traversal). Search input and every paging position are passed as parameters, never concatenated into SQL, and the page size, the number of columns revealed and the cursor are bounded. There is no endpoint that runs SQL.

### 6. A hostile or compromised database server

Responses are treated as data. Queries are read-only and time-bound. Names and cell values are rendered as text (React escapes them), never as HTML; every value is converted to text and cut inside the database, so a huge value never travels. **Residual:** a very large schema costs memory; results are capped per request.

## What happens on connection failure

The API returns a fixed message and a stable code (`unreachable`, `authentication_failed`, `ssl_error`, `timeout`...). The raw driver error, which can contain host names, user names or SQL, is never returned.

## What could leak through logs

Only error **codes** are logged for unexpected failures, never messages, bodies, URLs, cursors, rows or connection details. The invariant "the password never appears in any response" is tested on every connection route. The CLI prints the session-token link to the user's own terminal; that is by design, and the link is worthless after the process stops.

## Controls that are tested

Unit tests: `request-guard.test.ts` (Host, Origin, Sec-Fetch-Site, token, fail-closed), `error-response.test.ts` (guard inside every route), `web-server.test.ts` (loopback, token, telemetry off). Rule tests: `tests/security.test.ts` (every route guarded, no SQL endpoint, no CORS, no all-interfaces address; rows are read only behind the data-access check and are never logged; the data viewer keeps rows in component state only). Row tests: `rows-gate.test.ts`, the adapter tests against a real PostgreSQL (awkward names, every type, masking, row-level security, permissions, and that no error repeats a value), the end-to-end tests in `e2e/data-viewer.spec.ts`, and a test that taking, exporting or importing a snapshot never calls `getRows`.

## Not covered

Independent review, other operating systems and browsers, a full Content-Security-Policy, and hardening against a same-user attacker.
