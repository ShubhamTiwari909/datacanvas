# Threat model (Phase 10)

A short, honest model of what DataCanvas protects, from whom, and where it stops. Review it whenever a feature adds a route, a file, or a network call.

## Assets (what we protect)

| Asset                         | Why it matters                                         |
| ----------------------------- | ------------------------------------------------------ |
| Database credentials          | Give access to the user's data.                        |
| Schema metadata               | Table and column names reveal how a system works.      |
| Open database connections     | Whoever can call the API can use them (read metadata). |
| Saved files (`~/.datacanvas`) | Connection details (no password) and layouts.          |

## Attackers and what they can try

### 1. A malicious website open in the user's browser

| Attempt                                                   | Control                                                                                                                                | Residual        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `fetch("http://127.0.0.1:4747/api/...")` to read metadata | No CORS headers: the browser hides the response. `Sec-Fetch-Site: cross-site` is refused. Cookie is `SameSite=Strict`. Token required. | None known.     |
| Forged form or fetch that changes state (connect, delete) | Origin check; JSON-only bodies (a plain HTML form cannot send them); token.                                                            | None known.     |
| DNS rebinding: attacker domain resolves to 127.0.0.1      | Host check accepts only `127.0.0.1:<port>` and `localhost:<port>`.                                                                     | None known.     |
| Embedding the app in a frame (clickjacking)               | `frame-ancestors 'none'` and `X-Frame-Options: DENY`.                                                                                  | None known.     |
| Guessing the token                                        | 256-bit random value, constant-time comparison.                                                                                        | None practical. |

### 2. A web app on another port of 127.0.0.1

Cookies are shared across ports, so it receives the cookie when the browser visits it. From a browser it still cannot call our API (Origin / `Sec-Fetch-Site` checks, no CORS). **Residual:** its _server side_ could replay the cookie; that is a hostile local program (next).

### 3. Another program on the machine

- Other users: the server listens on loopback and requires the token; a different user cannot normally see the token. **Residual:** a hostile administrator.
- While DataCanvas runs, the token is also in `~/.datacanvas/run.json` (mode 0600) so a second launch can reopen the running instance. It is deleted on clean shutdown; a stale file is useless because the token dies with the process.
- Same user: can read the process environment and the CLI output, and can read `~/.datacanvas`. **Out of scope:** this attacker already controls the account. We still keep the password out of every file, so even they find no password at rest.

### 4. Someone who gets a diagram or workspace file

Contains table and column names but no row data. The export dialog says so. Imported workspace files are validated, size-limited, and can never overwrite existing data.

### 5. Hostile input

Every request body and query string is validated with a schema, size-limited, and answered with fixed messages. Identifiers are validated before touching the file system (no path traversal). Search input is passed as parameters, never concatenated into SQL. There is no endpoint that runs SQL.

### 6. A hostile or compromised database server

Responses are treated as data. Metadata queries are read-only and time-bound. Names are rendered as text (React escapes them), never as HTML. **Residual:** a very large schema costs memory; results are capped per request.

## What happens on connection failure

The API returns a fixed message and a stable code (`unreachable`, `authentication_failed`, `ssl_error`, `timeout`...). The raw driver error, which can contain host names, user names or SQL, is never returned.

## What could leak through logs

Only error **codes** are logged for unexpected failures, never messages, bodies, URLs or connection details. The invariant "the password never appears in any response" is tested on every connection route. The CLI prints the session-token link to the user's own terminal; that is by design, and the link is worthless after the process stops.

## Controls that are tested

Unit tests: `request-guard.test.ts` (Host, Origin, Sec-Fetch-Site, token, fail-closed), `error-response.test.ts` (guard inside every route), `web-server.test.ts` (loopback, token, telemetry off). Rule tests: `tests/security.test.ts` (every route guarded, no SQL endpoint, no CORS, no all-interfaces address).

## Not covered

Independent review, other operating systems and browsers, a full Content-Security-Policy, and hardening against a same-user attacker.
